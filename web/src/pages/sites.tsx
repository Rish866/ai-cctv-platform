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

interface Camera { id: string; name: string; site_id: string; status: string; rtsp_host: string | null; }

export function Cameras() {
  const cameras = useApi(() => api.get<{ cameras: Camera[] }>('/cameras'));
  const sites = useApi(() => api.get<{ sites: Site[] }>('/sites'));
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ siteId: '', name: '', rtspHost: '', rtspPath: '', username: '', password: '' });
  const [saveErr, setSaveErr] = useState<unknown>(null);
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  const create = async () => {
    setSaveErr(null);
    try {
      await api.post('/cameras', { ...form, siteId: form.siteId || sites.data?.sites[0]?.id });
      setShowAdd(false);
      setForm({ siteId: '', name: '', rtspHost: '', rtspPath: '', username: '', password: '' });
      cameras.reload();
    } catch (e) {
      setSaveErr(e);
    }
  };

  const test = async (id: string) => {
    try {
      const r = await api.post<{ reachable: boolean; status: string }>(`/cameras/${id}/test`);
      setTestMsg((m) => ({ ...m, [id]: r.reachable ? 'Reachable ✓' : 'Config incomplete' }));
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
            <thead><tr><th>Name</th><th>Host</th><th>Status</th><th>Test</th><th></th></tr></thead>
            <tbody>
              {cameras.data.cameras.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="muted">{c.rtsp_host ?? '—'}</td>
                  <td><Badge kind={c.status}>{c.status}</Badge></td>
                  <td>
                    <button className="btn secondary small" onClick={() => test(c.id)}>Test</button>
                    {testMsg[c.id] && <span className="muted" style={{ marginLeft: 8 }}>{testMsg[c.id]}</span>}
                  </td>
                  <td><button className="btn secondary small" onClick={() => remove(c.id)}>Delete</button></td>
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
            <div><label>RTSP host</label><input className="input" value={form.rtspHost} onChange={(e) => setForm({ ...form, rtspHost: e.target.value })} placeholder="192.168.1.10" /></div>
            <div><label>RTSP path</label><input className="input" value={form.rtspPath} onChange={(e) => setForm({ ...form, rtspPath: e.target.value })} placeholder="/stream1" /></div>
          </div>
          <div className="form-row">
            <div><label>Username</label><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
            <div><label>Password</label><input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
          </div>
          <ErrorBox error={saveErr} />
          <div className="row-actions" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="btn" onClick={create} disabled={!form.name}>Add camera</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
