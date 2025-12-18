/**
 * Digital twin simulator (lightweight)
 * - Maintains a simple dependency graph + security posture metrics
 * - Simulates proposed actions and predicts: breakage_risk, risk_delta, notes
 */

function defaultTwin() {
  return {
    services: {
      "checkout-api": { inboundOpenPorts: [443], allowedCidrs: ["0.0.0.0/0"], segmented: false },
      "auth": { inboundOpenPorts: [443], allowedCidrs: ["10.0.0.0/8"], segmented: true },
      "db": { inboundOpenPorts: [5432], allowedCidrs: ["10.0.0.0/8"], segmented: true }
    },
    iam: {
      principals: {
        "app-role": { permissions: ["s3:GetObject", "logs:PutLogEvents", "*:*"], mfa: false, tokenTtlMins: 120 },
        "breakglass-admin": { permissions: ["*:*"], mfa: true, tokenTtlMins: 30 }
      }
    },
    telemetryHints: {
      failedAuthRate5m: 0.0,
      anomalyScore: 0.0
    }
  };
}

function computeRiskScore(twin) {
  // Very simple heuristic risk score (0..100)
  let score = 0;

  // public exposure: any service with 0.0.0.0/0
  for (const s of Object.values(twin.services)) {
    if ((s.allowedCidrs || []).includes("0.0.0.0/0")) score += 20;
    score += (s.inboundOpenPorts || []).length * 2;
    if (!s.segmented) score += 5;
  }

  // IAM overly broad permissions
  for (const p of Object.values(twin.iam.principals)) {
    if ((p.permissions || []).includes("*:*")) score += 25;
    if (!p.mfa) score += 10;
    if ((p.tokenTtlMins || 0) > 60) score += 5;
  }

  // telemetry bumps
  score += Math.min(20, twin.telemetryHints.failedAuthRate5m * 10);
  score += Math.min(20, twin.telemetryHints.anomalyScore * 10);

  return Math.max(0, Math.min(100, score));
}

function simulateAction(twin, action) {
  const beforeRisk = computeRiskScore(twin);
  const next = JSON.parse(JSON.stringify(twin));
  const id = action.id;
  const params = action.params || {};
  let breakageRisk = 0;
  const notes = [];
  const applied_changes = {};

  // helper
  const svc = (name) => next.services[name];

  if (id === "tighten_inbound_rule") {
    const service = params.service || "checkout-api";
    const newCidr = params.new_cidr || "10.0.0.0/8";
    if (!svc(service)) {
      breakageRisk = 0.3;
      notes.push(`unknown service ${service}`);
    } else {
      // Tightening CIDR reduces exposure but might break clients if too strict
      svc(service).allowedCidrs = [newCidr];
      applied_changes[`services.${service}.allowedCidrs`] = [newCidr];
      if (newCidr !== "10.0.0.0/8") breakageRisk += 0.2;
      notes.push(`set ${service} allowedCidrs=${newCidr}`);
    }
  }

  if (id === "apply_segmentation") {
    const service = params.service || "checkout-api";
    if (svc(service)) {
      svc(service).segmented = true;
      applied_changes[`services.${service}.segmented`] = true;
      notes.push(`segmented ${service}`);
    }
  }

  if (id === "remove_iam_permission") {
    const principal = params.principal || "app-role";
    const perm = params.permission || "*:*";
    const p = next.iam.principals[principal];
    if (!p) {
      breakageRisk += 0.2;
      notes.push(`unknown principal ${principal}`);
    } else {
      p.permissions = (p.permissions || []).filter(x => x !== perm);
      applied_changes[`iam.principals.${principal}.permissions_removed`] = perm;
      // removing broad perm might break unknown flows
      breakageRisk += perm === "*:*" ? 0.15 : 0.05;
      notes.push(`removed ${perm} from ${principal}`);
    }
  }

  if (id === "enforce_mfa") {
    const principal = params.principal || "app-role";
    const p = next.iam.principals[principal];
    if (p) {
      p.mfa = true;
      applied_changes[`iam.principals.${principal}.mfa`] = true;
      breakageRisk += 0.05;
      notes.push(`enabled MFA for ${principal}`);
    }
  }

  if (id === "rotate_key") {
    // simulated key rotation
    applied_changes[`iam.key_rotation`] = "simulated";
    breakageRisk += 0.1;
    notes.push("rotated key (simulated)");
  }

  if (id === "reduce_token_ttl") {
    const principal = params.principal || "app-role";
    const ttl = params.new_ttl_mins || 30;
    const p = next.iam.principals[principal];
    if (p) {
      p.tokenTtlMins = ttl;
      applied_changes[`iam.principals.${principal}.tokenTtlMins`] = ttl;
      breakageRisk += 0.05;
      notes.push(`set token TTL for ${principal} to ${ttl}m`);
    }
  }

  if (id === "quarantine_workload") {
    // High risk action; strong breakage expectation
    applied_changes[`services.${params.service || 'checkout-api'}.quarantined`] = true;
    breakageRisk += 0.6;
    notes.push("quarantined workload (simulated)");
  }

  const afterRisk = computeRiskScore(next);
  const riskDelta = afterRisk - beforeRisk;

  // extra breakage if auth failures high and tightening is selected
  if (id === "tighten_inbound_rule" && twin.telemetryHints.failedAuthRate5m > 2) {
    breakageRisk += 0.1;
  }

  breakageRisk = Math.max(0, Math.min(1, breakageRisk));

  const pass_fail = breakageRisk <= 0.5;
  return {
    pass_fail,
    applied_changes,
    predicted_impact: {
      before_risk: beforeRisk,
      after_risk: afterRisk,
      risk_delta: riskDelta,
      breakage_risk: breakageRisk,
      notes
    },
    nextTwin: next
  };
}

function buildStateFromTelemetry(twin, recentTelemetry) {
  // Derive simple features from telemetry events
  let failedAuth = 0;
  let anomaly = 0;
  let publicExposure = 0;

  for (const ev of recentTelemetry) {
    // We may receive either raw event objects or only payload objects.
    // Handle both formats in a forgiving way.
    const type = ev?.type;
    const payload = ev?.payload ?? ev;

    if (type === "failed_auth" || payload?.count_5m != null) {
      failedAuth += Number(payload?.count_5m ?? 1);
    }
    if (type === "anomaly" || payload?.score != null) {
      anomaly += Number(payload?.score ?? 1);
    }
    if (type === "public_exposure" || payload?.cidr === "0.0.0.0/0") {
      publicExposure += 1;
    }
  }

  const features = {
    failed_auth_rate_5m: failedAuth,
    anomaly_score: anomaly,
    open_inbound_ports_count: publicExposure,
    privilege_entropy_score: estimatePrivilegeEntropy(twin),
    public_exposure_score: estimatePublicExposure(twin)
  };

  // update hints
  twin.telemetryHints.failedAuthRate5m = failedAuth;
  twin.telemetryHints.anomalyScore = anomaly;

  const risk_score = computeRiskScore(twin);
  return { features, risk_score };
}

function estimatePrivilegeEntropy(twin) {
  let broad = 0;
  let total = 0;
  for (const p of Object.values(twin.iam.principals)) {
    total += 1;
    if ((p.permissions || []).includes("*:*")) broad += 1;
  }
  return total === 0 ? 0 : (broad / total) * 10;
}

function estimatePublicExposure(twin) {
  let exposed = 0;
  let total = 0;
  for (const s of Object.values(twin.services)) {
    total += 1;
    if ((s.allowedCidrs || []).includes("0.0.0.0/0")) exposed += 1;
  }
  return total === 0 ? 0 : (exposed / total) * 10;
}

module.exports = {
  defaultTwin,
  computeRiskScore,
  simulateAction,
  buildStateFromTelemetry
};
