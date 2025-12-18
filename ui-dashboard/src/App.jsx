import React, { useEffect, useMemo, useState } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080'

async function api(path, opts) {
  const r = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  })
  const text = await r.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text } }
  if (!r.ok) throw new Error(data.error || text)
  return data
}

function Card({ title, children }) {
  return (
    <div style={{
      border: '1px solid #2a2a2a', borderRadius: 12, padding: 16,
      boxShadow: '0 1px 10px rgba(0,0,0,0.25)', background: '#111'
    }}>
      <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  )
}

function Json({ obj }) {
  return (
    <pre style={{
      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      background: '#0b0b0b', padding: 12, borderRadius: 10, border: '1px solid #1f1f1f'
    }}>
      {JSON.stringify(obj, null, 2)}
    </pre>
  )
}

export default function App() {
  const [timeline, setTimeline] = useState(null)
  const [cycleResult, setCycleResult] = useState(null)
  const [graph, setGraph] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const refresh = async () => {
    const t = await api('/timeline?limit=50')
    const g = await api('/graph')
    setTimeline(t)
    setGraph(g)
  }

  useEffect(() => {
    refresh().catch(e => setError(e.message))
  }, [])

  const lastDecisionId = useMemo(() => {
    if (!timeline?.decisions?.length) return null
    return timeline.decisions[0].id
  }, [timeline])

  const runSample = async () => {
    setError(null)
    setLoading(true)
    try {
      await api('/telemetry/sample', { method: 'POST', body: '{}' })
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const runCycle = async () => {
    setError(null)
    setLoading(true)
    try {
      const r = await api('/cycle/run', { method: 'POST', body: JSON.stringify({ environment: 'sandbox' }) })
      setCycleResult(r)
      await refresh()
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#0a0a0a', color: '#f1f1f1',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial'
    }}>
      <div style={{ maxWidth: 1150, margin: '0 auto', padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 800 }}>ZT-RL Prototype</div>
            <div style={{ opacity: 0.8, marginTop: 6 }}>
              Telemetry → RL decision → Zero Trust gate → digital twin sim → execution → reward
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button disabled={loading} onClick={runSample} style={btnStyle}>
              Generate Sample Telemetry
            </button>
            <button disabled={loading} onClick={runCycle} style={btnStylePrimary}>
              Run Hardening Cycle
            </button>
          </div>
        </div>

        {error && (
          <div style={{ marginTop: 16, padding: 12, borderRadius: 10, border: '1px solid #5a1a1a', background: '#1a0b0b' }}>
            <b>Error:</b> {error}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 18 }}>
          <Card title="Latest Cycle Result">
            {cycleResult ? <Json obj={cycleResult} /> : <div style={{ opacity: 0.75 }}>Run a cycle to see the end-to-end output.</div>}
          </Card>
          <Card title="Digital Twin Snapshot">
            {graph?.twin ? <Json obj={graph.twin} /> : <div style={{ opacity: 0.75 }}>Loading...</div>}
          </Card>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, marginTop: 16 }}>
          <Card title={`Telemetry (latest ${timeline?.telemetry_events?.length || 0})`}>
            <MiniList rows={timeline?.telemetry_events} fields={['ts','source','type']} />
          </Card>
          <Card title={`Decisions (latest ${timeline?.decisions?.length || 0})`}>
            <MiniList rows={timeline?.decisions} fields={['ts','action_id']} />
          </Card>
          <Card title={`Rewards (latest ${timeline?.rewards?.length || 0})`}>
            <MiniList rows={timeline?.rewards} fields={['ts','reward_value']} />
          </Card>
        </div>

        {lastDecisionId && (
          <div style={{ marginTop: 16, opacity: 0.75 }}>
            Tip: use the API endpoint <code>/decisions/{lastDecisionId}</code> for a complete view of a decision.
          </div>
        )}
      </div>
    </div>
  )
}

function MiniList({ rows, fields }) {
  const r = rows || []
  if (r.length === 0) return <div style={{ opacity: 0.75 }}>No data yet.</div>
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {r.slice(0, 10).map((x, i) => (
        <div key={i} style={{ padding: 10, borderRadius: 10, border: '1px solid #1f1f1f', background: '#0b0b0b' }}>
          {fields.map((f) => (
            <div key={f} style={{ fontSize: 12, opacity: 0.92 }}>
              <span style={{ opacity: 0.65 }}>{f}:</span> {String(x[f])}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

const btnStyle = {
  padding: '10px 12px', borderRadius: 10, border: '1px solid #2a2a2a',
  background: '#121212', color: '#f1f1f1', cursor: 'pointer'
}

const btnStylePrimary = {
  ...btnStyle,
  border: '1px solid #3a3a3a',
  background: '#1a1a1a'
}
