import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, EmptyState, ErrorBox, Loading, useApi } from '../components';

interface Camera { id: string; name: string; status: string; }

export function LiveMonitoring() {
  const { data, loading, error } = useApi(() => api.get<{ cameras: Camera[] }>('/cameras'));
  const [live, setLive] = useState<string[]>([]);

  useEffect(() => {
    // Subscribe to the tenant WebSocket channel; the server only sends THIS org's events.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === 'event.created') {
          setLive((l) => [`${new Date().toLocaleTimeString()} — ${msg.payload.severity} ${msg.payload.eventType}`, ...l].slice(0, 20));
        }
      } catch { /* ignore */ }
    };
    return () => ws.close();
  }, []);

  const openStream = async (id: string) => {
    const r = await api.post<{ stream: { playbackUrl: string; expiresAt: number } }>(`/cameras/${id}/stream`);
    alert(`Authenticated stream session created.\nPlayback URL (signed, expires soon):\n${r.stream.playbackUrl}`);
  };

  return (
    <div>
      <h1 className="page-title">Live Monitoring</h1>
      <p className="page-sub">Authenticated, tenant-scoped streams. Raw RTSP is never exposed to the browser.</p>
      <ErrorBox error={error} />
      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div>
          {loading ? (
            <Loading />
          ) : data && data.cameras.length > 0 ? (
            <div className="grid cols-2">
              {data.cameras.map((c) => (
                <div key={c.id} className="live-tile" onClick={() => openStream(c.id)} style={{ cursor: 'pointer' }}>
                  <div className="scan" />
                  <div className="status"><Badge kind={c.status}>{c.status}</Badge></div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 700 }}>{c.name}</div>
                    <div className="muted" style={{ fontSize: 12 }}>Click to open secure stream</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="card"><EmptyState>No cameras to monitor.</EmptyState></div>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Live event feed</h3>
          <p className="muted" style={{ fontSize: 13 }}>Real-time via tenant WebSocket channel.</p>
          {live.length === 0 ? (
            <EmptyState>Waiting for events… try "Simulate detection" on the AI Events page.</EmptyState>
          ) : (
            <ul>
              {live.map((l, i) => <li key={i} style={{ marginBottom: 6 }}>{l}</li>)}
            </ul>
          )}
        </div>
      </div>
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
                {['EMAIL', 'SMS', 'WEBHOOK', 'IN_APP'].map((c) => <option key={c}>{c}</option>)}
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
