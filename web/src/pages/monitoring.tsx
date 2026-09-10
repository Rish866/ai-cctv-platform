import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Badge, EmptyState, ErrorBox, Loading, useApi } from '../components';
import { eventLabel } from '../safety';
import { LivePlayer } from '../LivePlayer';

interface Camera {
  id: string;
  name: string;
  status: string;
  health?: string;
  inference_enabled?: boolean;
  inference_fps?: number;
  last_inference_at?: string | null;
}

interface AiStatus {
  ai: { mode: 'AI_ACTIVE' | 'DEMO_AI' | 'INFERENCE_OFFLINE'; inferenceConfigured: boolean; reachable: boolean; model: string };
  cameras: { total: number; online: number; offline: number; inference: number };
}

function AiStatusBadge({ mode }: { mode: AiStatus['ai']['mode'] }) {
  if (mode === 'AI_ACTIVE') return <span className="badge ONLINE">🟢 AI Active</span>;
  if (mode === 'DEMO_AI') return <span className="badge INVESTIGATING">🟡 Demo AI</span>;
  return <span className="badge OFFLINE">🔴 Inference Offline</span>;
}

// Live per-camera indicator derived from the tenant WebSocket feed.
type CamState = 'NORMAL' | 'ACTIVITY' | 'CRITICAL';
const CRITICAL_TYPES = new Set(['FIRE', 'FIRE_AND_SMOKE']);

function stateDot(s: CamState): { color: string; label: string } {
  if (s === 'CRITICAL') return { color: 'var(--crit)', label: '🔴 Critical Event' };
  if (s === 'ACTIVITY') return { color: 'var(--warn)', label: '🟡 Activity' };
  return { color: 'var(--accent)', label: '🟢 Normal' };
}

export function LiveMonitoring() {
  const { data, loading, error } = useApi(() => api.get<{ cameras: Camera[] }>('/cameras'));
  const aiStatus = useApi(() => api.get<AiStatus>('/system/ai-status'));
  const [live, setLive] = useState<string[]>([]);
  const [camStates, setCamStates] = useState<Record<string, CamState>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  useEffect(() => {
    // Subscribe to the tenant WebSocket channel; the server only sends THIS org's events.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        const p = msg.payload ?? {};
        // Any of our new safety/security event types OR the base event.created.
        if (p.eventType) {
          const label = eventLabel(p.eventType);
          setLive((l) => [`${new Date().toLocaleTimeString()} — ${p.severity ?? ''} ${label}`.trim(), ...l].slice(0, 25));
          if (p.cameraId) {
            const next: CamState = CRITICAL_TYPES.has(p.eventType) || p.severity === 'CRITICAL' ? 'CRITICAL' : 'ACTIVITY';
            setCamStates((s) => ({ ...s, [p.cameraId]: next }));
            // Auto-decay the indicator back to normal after a short window.
            clearTimeout(timers.current[p.cameraId]);
            timers.current[p.cameraId] = setTimeout(() => {
              setCamStates((s) => ({ ...s, [p.cameraId]: 'NORMAL' }));
            }, next === 'CRITICAL' ? 15000 : 6000);
          }
        }
      } catch { /* ignore */ }
    };
    return () => {
      ws.close();
      Object.values(timers.current).forEach(clearTimeout);
    };
  }, []);

  return (
    <div>
      <div className="toolbar">
        <div>
          <h1 className="page-title">Live Monitoring</h1>
          <p className="page-sub">Authenticated, tenant-scoped HLS streams. Raw RTSP is never exposed to the browser.</p>
        </div>
        <div className="row-actions" style={{ alignItems: 'center' }}>
          {aiStatus.data && <AiStatusBadge mode={aiStatus.data.ai.mode} />}
          {aiStatus.data && (
            <span className="muted" style={{ fontSize: 13 }}>
              {aiStatus.data.cameras.online}/{aiStatus.data.cameras.total} online · {aiStatus.data.cameras.inference} AI-enabled
            </span>
          )}
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div>
          {loading ? (
            <Loading />
          ) : data && data.cameras.length > 0 ? (
            <div className="grid cols-2">
              {data.cameras.map((c) => {
                const st = camStates[c.id] ?? 'NORMAL';
                const dot = stateDot(st);
                return (
                  <div
                    key={c.id}
                    className="live-tile"
                    onClick={() => setPlaying(c.id)}
                    style={{ cursor: 'pointer', boxShadow: st === 'CRITICAL' ? '0 0 0 2px var(--crit)' : undefined }}
                  >
                    <div className="scan" />
                    <div className="status"><Badge kind={c.status}>{c.status}</Badge></div>
                    <div style={{ position: 'absolute', top: 8, right: 8, fontSize: 12, color: dot.color, fontWeight: 700 }}>
                      {dot.label}
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontWeight: 700 }}>{c.name}</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        {c.inference_enabled ? `AI ${Number(c.inference_fps ?? 0)}fps` : 'AI off'} · click for secure live stream
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="card"><EmptyState>No cameras to monitor.</EmptyState></div>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Live event feed</h3>
          <p className="muted" style={{ fontSize: 13 }}>Real-time via tenant WebSocket channel — fire, smoke &amp; security included.</p>
          {live.length === 0 ? (
            <EmptyState>Waiting for events… try "Simulate detection" on the AI Events page.</EmptyState>
          ) : (
            <ul>
              {live.map((l, i) => <li key={i} style={{ marginBottom: 6 }}>{l}</li>)}
            </ul>
          )}
        </div>
      </div>
      {playing && <LivePlayer cameraId={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

export function Alerts() {
  const rules = useApi(() => api.get<{ rules: NotifRule[] }>('/notifications/rules'));
  const inbox = useApi(() => api.get<{ notifications: Notif[] }>('/notifications'));
  const [form, setForm] = useState({ name: '', channel: 'EMAIL', target: '', minSeverity: 'HIGH' });
  const [err, setErr] = useState<unknown>(null);

  const add = async () => {
    setErr(null);
    try {
      await api.post('/notifications/rules', form);
      setForm({ name: '', channel: 'EMAIL', target: '', minSeverity: 'HIGH' });
      rules.reload();
    } catch (e) { setErr(e); }
  };

  return (
    <div>
      <h1 className="page-title">Alerts</h1>
      <p className="page-sub">Notification rules and delivered alerts — recipients are tenant-scoped.</p>
      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Notification rules</h3>
          {rules.loading ? <Loading /> : (
            <table>
              <thead><tr><th>Name</th><th>Channel</th><th>Target</th><th>Min severity</th><th></th></tr></thead>
              <tbody>
                {rules.data?.rules.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td><td>{r.channel}</td><td className="muted">{r.target}</td>
                    <td><Badge kind={r.min_severity}>{r.min_severity}</Badge></td>
                    <td><button className="btn secondary small" onClick={async () => { await api.del(`/notifications/rules/${r.id}`); rules.reload(); }}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h4>Add rule</h4>
          <div className="form-row">
            <div><label>Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div><label>Channel</label>
              <select className="input" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
                {['EMAIL', 'SMS', 'WEBHOOK', 'IN_APP', 'WHATSAPP', 'PUSH'].map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div><label>Target</label><input className="input" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="ops@company.com" /></div>
            <div><label>Min severity</label>
              <select className="input" value={form.minSeverity} onChange={(e) => setForm({ ...form, minSeverity: e.target.value })}>
                {['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <ErrorBox error={err} />
          <button className="btn" style={{ marginTop: 12 }} onClick={add} disabled={!form.name || !form.target}>Add rule</button>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Delivered alerts</h3>
          {inbox.loading ? <Loading /> : inbox.data && inbox.data.notifications.length > 0 ? (
            <table>
              <thead><tr><th>Message</th><th>Channel</th><th>When</th></tr></thead>
              <tbody>
                {inbox.data.notifications.map((n) => (
                  <tr key={n.id}><td>{n.message}</td><td>{n.channel}</td><td className="muted">{new Date(n.created_at).toLocaleString()}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState>No alerts delivered yet.</EmptyState>}
        </div>
      </div>
    </div>
  );
}

interface NotifRule { id: string; name: string; channel: string; target: string; min_severity: string; }
interface Notif { id: string; message: string; channel: string; created_at: string; }
