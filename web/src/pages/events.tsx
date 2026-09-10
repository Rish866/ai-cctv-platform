import { useState } from 'react';
import { api } from '../api';
import { Badge, EmptyState, ErrorBox, Loading, Modal, useApi } from '../components';
import type { EventRow } from './dashboard';

const RULE_TYPES = [
  'PERSON_DETECTION', 'VEHICLE_DETECTION', 'RESTRICTED_AREA_INTRUSION', 'LINE_CROSSING',
  'LOITERING', 'CROWD_DETECTION', 'HELMET_DETECTION', 'SAFETY_VEST_DETECTION',
];

export function Events() {
  const { data, error, loading, reload } = useApi(() => api.get<{ events: EventRow[] }>('/events'));
  const cameras = useApi(() => api.get<{ cameras: { id: string; name: string }[] }>('/cameras'));
  const [detail, setDetail] = useState<string | null>(null);
  const [showSim, setShowSim] = useState(false);
  const [sim, setSim] = useState({ cameraId: '', eventType: 'PERSON_DETECTION', confidence: 0.9, severity: 'HIGH' });
  const [simErr, setSimErr] = useState<unknown>(null);

  const setStatus = async (id: string, status: string) => {
    await api.patch(`/events/${id}/status`, { status }).catch(() => undefined);
    reload();
  };

  const simulate = async () => {
    setSimErr(null);
    try {
      await api.post('/events/ingest', {
        cameraId: sim.cameraId || cameras.data?.cameras[0]?.id,
        eventType: sim.eventType,
        confidence: Number(sim.confidence),
        severity: sim.severity,
        snapshotBase64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      });
      setShowSim(false);
      reload();
    } catch (e) {
      setSimErr(e);
    }
  };

  return (
    <div>
      <div className="toolbar">
        <div>
          <h1 className="page-title">AI Events</h1>
          <p className="page-sub">Detections from your cameras. Scoped to this organization only.</p>
        </div>
        <button className="btn" onClick={() => setShowSim(true)} disabled={!cameras.data?.cameras.length}>Simulate detection</button>
      </div>
      <ErrorBox error={error} />
      {loading ? (
        <Loading />
      ) : data && data.events.length > 0 ? (
        <div className="card">
          <table>
            <thead><tr><th>Type</th><th>Severity</th><th>Confidence</th><th>Camera</th><th>Status</th><th>When</th><th></th></tr></thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td>{e.event_type}</td>
                  <td><Badge kind={e.severity}>{e.severity}</Badge></td>
                  <td>{Math.round((e.confidence ?? 0) * 100)}%</td>
                  <td>{e.camera_name}</td>
                  <td><Badge kind={e.status}>{e.status}</Badge></td>
                  <td className="muted">{new Date(e.occurred_at).toLocaleString()}</td>
                  <td><button className="btn secondary small" onClick={() => setDetail(e.id)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card"><EmptyState>No events yet.</EmptyState></div>
      )}

      {detail && <EventDetail id={detail} onClose={() => setDetail(null)} onStatus={setStatus} />}

      {showSim && (
        <Modal title="Simulate an AI detection" onClose={() => setShowSim(false)}>
          <p className="muted">Runs the ingestion pipeline against one of your cameras (validates ownership server-side).</p>
          <label>Camera</label>
          <select className="input" value={sim.cameraId} onChange={(e) => setSim({ ...sim, cameraId: e.target.value })}>
            {cameras.data?.cameras.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label>Type</label>
          <select className="input" value={sim.eventType} onChange={(e) => setSim({ ...sim, eventType: e.target.value })}>
            {RULE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="form-row">
            <div><label>Confidence</label><input className="input" type="number" min={0} max={1} step={0.05} value={sim.confidence} onChange={(e) => setSim({ ...sim, confidence: Number(e.target.value) })} /></div>
            <div>
              <label>Severity</label>
              <select className="input" value={sim.severity} onChange={(e) => setSim({ ...sim, severity: e.target.value })}>
                {['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map((s) => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <ErrorBox error={simErr} />
          <div className="row-actions" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <button className="btn secondary" onClick={() => setShowSim(false)}>Cancel</button>
            <button className="btn" onClick={simulate}>Generate event</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function EventDetail({ id, onClose, onStatus }: { id: string; onClose: () => void; onStatus: (id: string, s: string) => void }) {
  const { data, loading } = useApi(() =>
    api.get<{ event: EventRow & { metadata: unknown }; detections: unknown[]; evidence: { id: string; kind: string }[] }>(`/events/${id}`),
  );
  const [evUrl, setEvUrl] = useState<string | null>(null);

  const loadEvidence = async (evidenceId: string) => {
    const r = await api.get<{ evidence: { url: string } }>(`/events/${id}/evidence/${evidenceId}/url`);
    setEvUrl(r.evidence.url);
  };

  return (
    <Modal title="Event detail" onClose={onClose}>
      {loading || !data ? (
        <Loading />
      ) : (
        <div>
          <div className="kv">
            <div>Type</div><div>{data.event.event_type}</div>
            <div>Severity</div><div><Badge kind={data.event.severity}>{data.event.severity}</Badge></div>
            <div>Confidence</div><div>{Math.round((data.event.confidence ?? 0) * 100)}%</div>
            <div>Status</div><div><Badge kind={data.event.status}>{data.event.status}</Badge></div>
          </div>
          <h4>Evidence</h4>
          {data.evidence.length === 0 ? (
            <p className="muted">No evidence.</p>
          ) : (
            data.evidence.map((ev) => (
              <div key={ev.id} style={{ marginBottom: 8 }}>
                <button className="btn secondary small" onClick={() => loadEvidence(ev.id)}>Load {ev.kind} (signed URL)</button>
              </div>
            ))
          )}
          {evUrl && <img src={evUrl} alt="evidence" style={{ maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 8, marginTop: 8 }} />}
          <h4>Handle</h4>
          <div className="row-actions">
            <button className="btn secondary small" onClick={() => onStatus(id, 'ACKNOWLEDGED')}>Acknowledge</button>
            <button className="btn small" onClick={() => onStatus(id, 'RESOLVED')}>Resolve</button>
            <button className="btn secondary small" onClick={() => onStatus(id, 'DISMISSED')}>Dismiss</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
