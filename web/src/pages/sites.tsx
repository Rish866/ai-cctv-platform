import { useState } from 'react';
import { api, ApiError } from '../api';
import { Badge, EmptyState, ErrorBox, Loading, Modal, useApi } from '../components';

interface Site { id: string; name: string; address: string | null; timezone: string; camera_count: number; }

export function Sites() {
  const { data, error, loading, reload } = useApi(() => api.get<{ sites: Site[] }>('/sites'));
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', address: '', timezone: 'UTC' });
  const [saveErr, setSaveErr] = useState<unknown>(null);

  const create = async () => {
    setSaveErr(null);
    try {
      await api.post('/sites', form);
      setShowAdd(false);
      setForm({ name: '', address: '', timezone: 'UTC' });
      reload();
    } catch (e) {
      setSaveErr(e);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this site and all its cameras/events?')) return;
    await api.del(`/sites/${id}`).catch(() => undefined);
    reload();
  };

  return (
    <div>
      <div className="toolbar">
        <div>
          <h1 className="page-title">Sites & Zones</h1>
          <p className="page-sub">Physical locations you monitor.</p>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}>+ Add site</button>
      </div>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : data && data.sites.length > 0 ? (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Address</th><th>Timezone</th><th>Cameras</th><th></th></tr></thead>
            <tbody>
              {data.sites.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td className="muted">{s.address ?? '—'}</td>
                  <td><span className="pill">{s.timezone}</span></td>
                  <td>{s.camera_count}</td>
                  <td className="row-actions">
                    <button className="btn secondary small" onClick={() => remove(s.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card"><EmptyState>No sites yet. Add your first site to begin.</EmptyState></div>
      )}

      {showAdd && (
        <Modal title="Add site" onClose={() => setShowAdd(false)}>
          <label>Name</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <label>Address</label>
          <input className="input" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          <label>Timezone</label>
          <input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} />
          <ErrorBox error={saveErr} />
          <div className="row-actions" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="btn" onClick={create} disabled={!form.name}>Create site</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

interface Camera {
  id: string;
  name: string;
  site_id: string;
  status: string;
  health?: string;
  rtsp_host: string | null;
  inference_enabled?: boolean;
  inference_fps?: number;
  resolution?: string | null;
}

export function Cameras() {
  const cameras = useApi(() => api.get<{ cameras: Camera[] }>('/cameras'));
  const sites = useApi(() => api.get<{ sites: Site[] }>('/sites'));
  const [showAdd, setShowAdd] = useState(false);
  const emptyForm = {
    siteId: '', name: '', rtspHost: '', rtspPath: '', rtspPort: 554, streamProfile: 'main',
    username: '', password: '', inferenceEnabled: false, inferenceFps: 2,
  };
  const [form, setForm] = useState({ ...emptyForm });
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const [rulesFor, setRulesFor] = useState<Camera | null>(null);

  const create = async () => {
    setSaveErr(null);
    try {
      await api.post('/cameras', { ...form, siteId: form.siteId || sites.data?.sites[0]?.id });
      setShowAdd(false);
      setForm({ ...emptyForm });
      cameras.reload();
    } catch (e) {
      setSaveErr(e);
    }
  };

  // Real connection test via ffprobe. Returns a safe diagnostic (never creds).
  const test = async (id: string) => {
    setTestMsg((m) => ({ ...m, [id]: 'Testing…' }));
    try {
      const r = await api.post<{ success: boolean; status: string; latencyMs: number; message: string }>(
        `/cameras/${id}/test-connection`,
      );
      setTestMsg((m) => ({ ...m, [id]: `${r.success ? '✓' : '✗'} ${r.status} — ${r.message}${r.success ? ` (${r.latencyMs}ms)` : ''}` }));
      cameras.reload();
    } catch (e) {
      setTestMsg((m) => ({ ...m, [id]: e instanceof ApiError ? e.message : 'Test failed' }));
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this camera?')) return;
    await api.del(`/cameras/${id}`).catch(() => undefined);
    cameras.reload();
  };

  return (
    <div>
      <div className="toolbar">
        <div>
          <h1 className="page-title">Cameras</h1>
          <p className="page-sub">RTSP credentials are encrypted server-side and never shown here.</p>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)} disabled={!sites.data?.sites.length}>+ Add camera</button>
      </div>
      {!sites.loading && !sites.data?.sites.length && (
        <div className="card"><EmptyState>Create a site first, then add cameras to it.</EmptyState></div>
      )}
      {cameras.loading ? (
        <Loading />
      ) : cameras.data && cameras.data.cameras.length > 0 ? (
        <div className="card">
          <table>
            <thead><tr><th>Name</th><th>Host</th><th>Status</th><th>AI</th><th>Test connection</th><th>Detection rules</th></tr></thead>
            <tbody>
              {cameras.data.cameras.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}{c.resolution ? <span className="muted" style={{ fontSize: 12 }}> · {c.resolution}</span> : null}</td>
                  <td className="muted">{c.rtsp_host ?? '—'}</td>
                  <td><Badge kind={c.status}>{c.status}</Badge></td>
                  <td>{c.inference_enabled ? <span className="pill">AI {Number(c.inference_fps ?? 0)}fps</span> : <span className="muted">off</span>}</td>
                  <td>
                    <button className="btn secondary small" onClick={() => test(c.id)}>Test</button>
                    {testMsg[c.id] && <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>{testMsg[c.id]}</span>}
                  </td>
                  <td className="row-actions">
                    <button className="btn secondary small" onClick={() => setRulesFor(c)}>Rules</button>
                    <button className="btn secondary small" onClick={() => remove(c.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        sites.data?.sites.length ? <div className="card"><EmptyState>No cameras yet.</EmptyState></div> : null
      )}

      {showAdd && (
        <Modal title="Add camera" onClose={() => setShowAdd(false)}>
          <label>Site</label>
          <select className="input" value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
            {sites.data?.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <label>Camera name</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <div className="form-row">
            <div style={{ flex: 3 }}><label>RTSP host / IP</label><input className="input" value={form.rtspHost} onChange={(e) => setForm({ ...form, rtspHost: e.target.value })} placeholder="192.168.1.10" /></div>
            <div><label>Port</label><input className="input" type="number" value={form.rtspPort} onChange={(e) => setForm({ ...form, rtspPort: Number(e.target.value) })} /></div>
          </div>
          <div className="form-row">
            <div style={{ flex: 2 }}><label>RTSP path</label><input className="input" value={form.rtspPath} onChange={(e) => setForm({ ...form, rtspPath: e.target.value })} placeholder="/Streaming/Channels/101" /></div>
            <div><label>Stream profile</label>
              <select className="input" value={form.streamProfile} onChange={(e) => setForm({ ...form, streamProfile: e.target.value })}>
                {['main', 'sub'].map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
          </div>
          <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
            Credentials are encrypted at rest and never shown again. The full RTSP URL (with password) never leaves the server.
          </p>
          <div className="form-row">
            <div><label>Username</label><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
            <div><label>Password</label><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
          </div>
          <div className="form-row" style={{ alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
              <input type="checkbox" checked={form.inferenceEnabled} onChange={(e) => setForm({ ...form, inferenceEnabled: e.target.checked })} />
              Enable AI inference
            </label>
            <div><label>Inference FPS</label><input className="input" type="number" min={0} max={30} step={0.5} value={form.inferenceFps} onChange={(e) => setForm({ ...form, inferenceFps: Number(e.target.value) })} /></div>
          </div>
          <ErrorBox error={saveErr} />
          <div className="row-actions" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="btn" onClick={create} disabled={!form.name}>Add camera</button>
          </div>
        </Modal>
      )}

      {rulesFor && <CameraRulesModal camera={rulesFor} onClose={() => setRulesFor(null)} />}
    </div>
  );
}

// ---------------- Detection rule configuration (ADD-ON) ----------------
const ALL_RULE_TYPES: { type: string; label: string }[] = [
  { type: 'PERSON_DETECTION', label: 'Person Detection' },
  { type: 'VEHICLE_DETECTION', label: 'Vehicle Detection' },
  { type: 'RESTRICTED_AREA_INTRUSION', label: 'Restricted Area Intrusion' },
  { type: 'LINE_CROSSING', label: 'Line Crossing' },
  { type: 'LOITERING', label: 'Loitering' },
  { type: 'CROWD_DETECTION', label: 'Crowd Detection' },
  { type: 'HELMET_DETECTION', label: 'Helmet Detection' },
  { type: 'SAFETY_VEST_DETECTION', label: 'Safety Vest Detection' },
  { type: 'FIRE', label: 'Fire Detection' },
  { type: 'SMOKE', label: 'Smoke Detection' },
  { type: 'FIRE_AND_SMOKE', label: 'Fire + Smoke' },
  { type: 'UNAUTHORIZED_ENTRY', label: 'Unauthorized Entry' },
  { type: 'AFTER_HOURS_ACTIVITY', label: 'After-Hours Activity' },
  { type: 'OBJECT_REMOVED', label: 'Object Removed' },
  { type: 'UNAUTHORIZED_VEHICLE', label: 'Unauthorized Vehicle' },
  { type: 'RESTRICTED_ZONE_ACTIVITY', label: 'Restricted Zone Activity' },
];
const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'PUSH', 'IN_APP', 'WEBHOOK'];

interface Rule {
  id: string;
  rule_type: string;
  enabled: boolean;
  severity: string;
  min_confidence: number;
  cooldown_seconds: number;
  notify_channels: string[];
}

function CameraRulesModal({ camera, onClose }: { camera: { id: string; name: string }; onClose: () => void }) {
  const rules = useApi(() => api.get<{ rules: Rule[] }>('/ai-rules'));
  const [form, setForm] = useState({
    ruleType: 'FIRE',
    severity: 'CRITICAL',
    minConfidence: 0.7,
    cooldownSeconds: 30,
    minDurationMs: 2000,
    channels: ['IN_APP'] as string[],
  });
  const [err, setErr] = useState<unknown>(null);

  const cameraRules = (rules.data?.rules ?? []).filter(() => true);

  const toggleChannel = (c: string) =>
    setForm((f) => ({ ...f, channels: f.channels.includes(c) ? f.channels.filter((x) => x !== c) : [...f.channels, c] }));

  const save = async () => {
    setErr(null);
    try {
      await api.post('/ai-rules', {
        cameraId: camera.id,
        ruleType: form.ruleType,
        severity: form.severity,
        minConfidence: Number(form.minConfidence),
        cooldownSeconds: Number(form.cooldownSeconds),
        minDurationMs: Number(form.minDurationMs),
        notifyChannels: form.channels,
        enabled: true,
      });
      rules.reload();
    } catch (e) {
      setErr(e);
    }
  };

  const removeRule = async (id: string) => {
    await api.del(`/ai-rules/${id}`).catch(() => undefined);
    rules.reload();
  };

  return (
    <Modal title={`Detection rules — ${camera.name}`} onClose={onClose}>
      <p className="muted" style={{ fontSize: 13 }}>
        Configure fire, smoke and security detection for this camera. All rules belong to your organization only.
      </p>
      {rules.loading ? (
        <Loading />
      ) : cameraRules.length > 0 ? (
        <table>
          <thead><tr><th>Type</th><th>Severity</th><th>Conf.</th><th>Cooldown</th><th>Channels</th><th></th></tr></thead>
          <tbody>
            {cameraRules.map((r) => (
              <tr key={r.id}>
                <td>{ALL_RULE_TYPES.find((t) => t.type === r.rule_type)?.label ?? r.rule_type}</td>
                <td><span className={`badge ${r.severity}`}>{r.severity}</span></td>
                <td>{Math.round((r.min_confidence ?? 0) * 100)}%</td>
                <td>{r.cooldown_seconds}s</td>
                <td className="muted">{(r.notify_channels ?? []).join(', ') || '—'}</td>
                <td><button className="btn secondary small" onClick={() => removeRule(r.id)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No rules yet for your organization.</p>
      )}

      <h4>Add rule</h4>
      <label>Detection type</label>
      <select className="input" value={form.ruleType} onChange={(e) => setForm({ ...form, ruleType: e.target.value })}>
        {ALL_RULE_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
      </select>
      <div className="form-row">
        <div>
          <label>Severity</label>
          <select className="input" value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
            {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label>Confidence ≥</label>
          <input className="input" type="number" min={0} max={1} step={0.05} value={form.minConfidence} onChange={(e) => setForm({ ...form, minConfidence: Number(e.target.value) })} />
        </div>
      </div>
      <div className="form-row">
        <div>
          <label>Cooldown (sec)</label>
          <input className="input" type="number" min={0} value={form.cooldownSeconds} onChange={(e) => setForm({ ...form, cooldownSeconds: Number(e.target.value) })} />
        </div>
        <div>
          <label>Min duration (ms)</label>
          <input className="input" type="number" min={0} value={form.minDurationMs} onChange={(e) => setForm({ ...form, minDurationMs: Number(e.target.value) })} />
        </div>
      </div>
      <label>Notification channels</label>
      <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
        {CHANNELS.map((c) => (
          <button key={c} type="button" className={`btn ${form.channels.includes(c) ? '' : 'secondary'} small`} onClick={() => toggleChannel(c)}>
            {form.channels.includes(c) ? '✓ ' : ''}{c}
          </button>
        ))}
      </div>
      <ErrorBox error={err} />
      <div className="row-actions" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn secondary" onClick={onClose}>Close</button>
        <button className="btn" onClick={save}>Save rule</button>
      </div>
    </Modal>
  );
}
