const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { query } = require('./db');
const { getSandbox, saveSandbox, getTwin, saveTwin } = require('./state');

let twinLib;
try {
  twinLib = require('/digital-twin/index.js');
} catch (e) {
  twinLib = require('../../digital-twin/index.js');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 8080;
const RL_ENGINE_URL = process.env.RL_ENGINE_URL || 'http://localhost:8000';
const OPA_URL = process.env.OPA_URL || 'http://localhost:8181';

const ACTIONS = [
  { id: 'tighten_inbound_rule', label: 'Tighten inbound CIDR (remove 0.0.0.0/0)' },
  { id: 'remove_iam_permission', label: 'Remove broad IAM permission (*:*)' },
  { id: 'enforce_mfa', label: 'Enforce MFA' },
  { id: 'rotate_key', label: 'Rotate key' },
  { id: 'apply_segmentation', label: 'Apply service segmentation' },
  { id: 'reduce_token_ttl', label: 'Reduce token TTL' },
  { id: 'quarantine_workload', label: 'Quarantine workload' }
];

async function ensureDb() {
  // smoke query
  await query('SELECT 1');
}

app.get('/health', async (req, res) => {
  try {
    await ensureDb();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get('/actions', (req, res) => res.json({ actions: ACTIONS }));

app.post('/telemetry/ingest', async (req, res) => {
  const { source = 'unknown', type = 'event', payload = {} } = req.body || {};
  const r = await query(
    'INSERT INTO telemetry_events (source, type, payload) VALUES ($1,$2,$3) RETURNING id, ts',
    [source, type, payload]
  );
  res.json({ inserted: r.rows[0] });
});

app.post('/telemetry/sample', async (req, res) => {
  // Inserts a small set of "interesting" telemetry events.
  const samples = [
    { source: 'auth', type: 'failed_auth', payload: { count_5m: 42, principal: 'app-role' } },
    { source: 'net', type: 'public_exposure', payload: { service: 'checkout-api', cidr: '0.0.0.0/0', port: 443 } },
    { source: 'sec', type: 'anomaly', payload: { score: 0.78, reason: 'spike in unusual geo logins' } },
    { source: 'iam', type: 'broad_permission', payload: { principal: 'app-role', permission: '*:*' } }
  ];
  const inserted = [];
  for (const s of samples) {
    const r = await query(
      'INSERT INTO telemetry_events (source, type, payload) VALUES ($1,$2,$3) RETURNING id, ts',
      [s.source, s.type, s.payload]
    );
    inserted.push({ ...s, id: r.rows[0].id, ts: r.rows[0].ts });
  }
  res.json({ inserted });
});

app.get('/timeline', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const events = await query('SELECT * FROM telemetry_events ORDER BY ts DESC LIMIT $1', [limit]);
  const decisions = await query('SELECT * FROM decisions ORDER BY ts DESC LIMIT $1', [limit]);
  const sims = await query('SELECT * FROM simulations ORDER BY ts DESC LIMIT $1', [limit]);
  const execs = await query('SELECT * FROM executions ORDER BY ts DESC LIMIT $1', [limit]);
  const rewards = await query('SELECT * FROM rewards ORDER BY ts DESC LIMIT $1', [limit]);

  res.json({
    telemetry_events: events.rows,
    decisions: decisions.rows,
    simulations: sims.rows,
    executions: execs.rows,
    rewards: rewards.rows
  });
});

app.get('/decisions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const d = await query('SELECT * FROM decisions WHERE id=$1', [id]);
  if (d.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const s = await query('SELECT * FROM simulations WHERE decision_id=$1 ORDER BY ts DESC LIMIT 1', [id]);
  const e = await query('SELECT * FROM executions WHERE decision_id=$1 ORDER BY ts DESC LIMIT 1', [id]);
  const r = await query('SELECT * FROM rewards WHERE decision_id=$1 ORDER BY ts DESC LIMIT 1', [id]);
  res.json({ decision: d.rows[0], simulation: s.rows[0] || null, execution: e.rows[0] || null, reward: r.rows[0] || null });
});

app.get('/graph', (req, res) => {
  const twin = getTwin(twinLib.defaultTwin);
  res.json({ twin });
});

function chooseDefaultParams(actionId) {
  switch (actionId) {
    case 'tighten_inbound_rule':
      return { service: 'checkout-api', new_cidr: '10.0.0.0/8' };
    case 'remove_iam_permission':
      return { principal: 'app-role', permission: '*:*' };
    case 'enforce_mfa':
      return { principal: 'app-role' };
    case 'rotate_key':
      return { principal: 'app-role', key: 'access_key_1' };
    case 'apply_segmentation':
      return { service: 'checkout-api', segmented: true };
    case 'reduce_token_ttl':
      return { principal: 'app-role', new_ttl_mins: 15 };
    case 'quarantine_workload':
      return { service: 'checkout-api' };
    default:
      return {};
  }
}

function computeReward({ beforeRisk, afterRisk, breakageRisk, policyAllowed, executed }) {
  const risk_reduction = Math.max(0, beforeRisk - afterRisk);
  const break_penalty = breakageRisk;
  const policy_penalty = policyAllowed ? 0 : 1;
  const exec_penalty = executed ? 0 : 1;

  const reward = (risk_reduction * 1.0) - (break_penalty * 2.0) - (policy_penalty * 1.0) - (exec_penalty * 0.5);
  return {
    reward,
    breakdown: { risk_reduction, breakageRisk, policy_penalty, exec_penalty }
  };
}

async function callOPA(action, context) {
  const url = `${OPA_URL}/v1/data/zt/allow`;
  const body = { input: { action, context } };
  const resp = await axios.post(url, body, { timeout: 4000 });
  // OPA returns {"result": {allowed: bool, reason: str}}
  return resp.data?.result || { allowed: false, reason: 'no-opa-result' };
}

async function callRLAct(state) {
  const url = `${RL_ENGINE_URL}/rl/act`;
  const resp = await axios.post(url, { state, actions: ACTIONS.map(a => a.id) }, { timeout: 4000 });
  return resp.data;
}

async function callRLLearn({ state, action_id, reward }) {
  const url = `${RL_ENGINE_URL}/rl/learn`;
  const resp = await axios.post(url, { state, action_id, reward }, { timeout: 4000 });
  return resp.data;
}

function applyToSandboxAndTwin({ twin, action }) {
  // In a real system, this would be Terraform/K8s/IAM calls.
  // Here we update a sandbox state file + update the twin.
  const sandbox = getSandbox();
  const now = new Date().toISOString();

  const simResult = twinLib.simulateAction(twin, action);
  const changes = simResult.applied_changes || {};

  sandbox.changes.push({ ts: now, action, changes });
  sandbox.current = { ...sandbox.current, ...changes };
  saveSandbox(sandbox);

  saveTwin(simResult.nextTwin);

  return { sandbox, nextTwin: simResult.nextTwin, applied_changes: changes };
}

app.post('/cycle/run', async (req, res) => {
  const environment = (req.body?.environment || 'sandbox');

  // 1) load twin
  let twin = getTwin(twinLib.defaultTwin);
  const beforeRisk = twinLib.computeRiskScore(twin);

  // 2) build state from latest telemetry (last 30)
  const t = await query('SELECT * FROM telemetry_events ORDER BY ts DESC LIMIT 30');
  const { features, risk_score } = twinLib.buildStateFromTelemetry(
    twin,
    t.rows.map(x => ({ type: x.type, payload: x.payload }))
  );

  // 3) persist state
  const stateInsert = await query(
    'INSERT INTO system_state (features, risk_score) VALUES ($1,$2) RETURNING id, ts',
    [features, risk_score]
  );
  const stateId = stateInsert.rows[0].id;

  // 4) ask RL for an action
  const rl = await callRLAct({ features, risk_score });
  const action_id = rl.action_id;
  const action_params = { ...(rl.params || {}), ...chooseDefaultParams(action_id) };
  const action = { id: action_id, params: action_params };

  // 5) store decision
  const decisionInsert = await query(
    'INSERT INTO decisions (state_id, action_id, action_params, rl_meta) VALUES ($1,$2,$3,$4) RETURNING id, ts',
    [stateId, action_id, action_params, rl]
  );
  const decisionId = decisionInsert.rows[0].id;

  // 6) policy gate (OPA)
  const context = {
    environment,
    actor: { type: 'system', name: 'autonomous-hardener' },
    resource: { service: action_params.service || 'n/a', principal: action_params.principal || 'n/a' },
    state: { risk_score }
  };
  const policy = await callOPA(action, context);

  // 7) simulate in digital twin
  const sim = twinLib.simulateAction(twin, action);
  const breakageRisk = sim.predicted_impact.breakage_risk;

  // Store simulation
  await query(
    'INSERT INTO simulations (decision_id, pass_fail, predicted_impact, reason) VALUES ($1,$2,$3,$4)',
    [decisionId, policy.allowed && sim.pass_fail, sim.predicted_impact, policy.reason]
  );

  // 8) execute if allowed & sim pass
  let executed = false;
  let execStatus = 'skipped';
  let applied_changes = {};
  if (policy.allowed && sim.pass_fail) {
    const exec = applyToSandboxAndTwin({ twin, action });
    executed = true;
    execStatus = 'applied';
    applied_changes = exec.applied_changes;
    twin = exec.nextTwin;
  }

  await query(
    'INSERT INTO executions (decision_id, status, applied_changes) VALUES ($1,$2,$3)',
    [decisionId, execStatus, applied_changes]
  );

  // 9) compute post risk + reward
  const afterRisk = twinLib.computeRiskScore(twin);
  const rewardObj = computeReward({ beforeRisk, afterRisk, breakageRisk, policyAllowed: policy.allowed, executed });

  await query(
    'INSERT INTO rewards (decision_id, reward_value, reward_breakdown) VALUES ($1,$2,$3)',
    [decisionId, rewardObj.reward, rewardObj.breakdown]
  );

  // 10) update RL
  await callRLLearn({ state: { features, risk_score }, action_id, reward: rewardObj.reward });

  res.json({
    decision_id: decisionId,
    state: { id: stateId, risk_score, features },
    rl,
    policy,
    simulation: sim,
    execution: { executed, status: execStatus, applied_changes },
    reward: rewardObj
  });
});

app.listen(PORT, () => {
  console.log(`control-plane listening on :${PORT}`);
});
