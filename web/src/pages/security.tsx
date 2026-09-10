import { useState } from 'react';
import { api } from '../api';
import { Badge, EmptyState, ErrorBox, Loading, Modal, StatCard, useApi } from '../components';
import { eventLabel, INCIDENT_STATUSES } from '../safety';

interface SecEvent {
  id: string;
  event_type: string;
  severity: string;
  status: string;
  confidence: number;
  occurred_at: string;
  camera_name: string;
  site_name: string;
  camera_id: string;
  site_id: string;
}

const CATEGORIES = [
  { key: '', label: 'All' },
  { key: 'FIRE', label: 'Fire & Safety' },
  { key: 'SECURITY', label: 'Security' },
];

export function SecurityCenter() {
  const [category, setCategory] = useState('');
  const [severity, setSeverity] = useState('');
  const [status, setStatus] = useState('');
  const [detail, setDetail] = useState<string | null>(null);

  const q = new URLSearchParams();
  if (category) q.set('category', category);
  if (severity) q.set('severity', severity);
  if (status) q.set('status', status);
  const qs = q.toString();

  const events = useApi(() => api.get<{ events: SecEvent[] }>(`/events/security/list${qs ? `?${qs}` : ''}`), [qs]);
  const stats = useApi(() => api.get<{ stats: SecStats }>('/dashboard/security'));

  return (
    <div>
      <h1 className="page-title">Security Center</h1>
      <p className="page-sub">
        Fire, smoke and security incidents for your organization. Detections show confidence and evidence — never claims of certainty.
      </p>
      <ErrorBox error={events.error} />

      {stats.data && (
        <div className="grid cols-4" style={{ marginTop: 16, marginBottom: 16 }}>
          <StatCard label="Fire incidents today" value={stats.data.stats.fire_today} tone="crit" />
          <StatCard label="Smoke incidents today" value={stats.data.stats.smoke_today} tone="warn" />
          <StatCard label="Security incidents today" value={stats.data.stats.security_today} />
          <StatCard label="Open incidents" value={stats.data.stats.open_incidents} tone="warn" />
        </div>
      )}

      <div className="card">
        <div className="toolbar">
          <div className="row-actions">
            {CATEGORIES.map((c) => (
              <button key={c.key} className={`btn ${category === c.key ? '' : 'secondary'} small`} onClick={() => setCategory(c.key)}>
                {c.label}
              </button>
            ))}
          </div>
          <div className="row-actions">
            <select className="input" style={{ maxWidth: 150 }} value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">Any severity</option>
              {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((s) => <option key={s}>{s}</option>)}
            </select>
            <select className="input" style={{ maxWidth: 160 }} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any status</option>
              {INCIDENT_STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>
        </div>

        {events.loading ? (
          <Loading />
        ) : events.data && events.data.events.length > 0 ? (
          <table>
            <thead>
              <tr><th>Incident</th><th>Severity</th><th>Confidence</th><th>Camera</th><th>Site</th><th>Status</th><th>When</th><th></th></tr>
            </thead>
            <tbody>
              {events.data.events.map((e) => (
                <tr key={e.id}>
                  <td>{eventLabel(e.event_type)}</td>
                  <td><Badge kind={e.severity}>{e.severity}</Badge></td>
                  <td>{Math.round((e.confidence ?? 0) * 100)}%</td>
                  <td>{e.camera_name}</td>
                  <td>{e.site_name}</td>
                  <td><Badge kind={e.status}>{e.status}</Badge></td>
                  <td className="muted">{new Date(e.occurred_at).toLocaleString()}</td>
                  <td><button className="btn secondary small" onClick={() => setDetail(e.id)}>Manage</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>No incidents match these filters.</EmptyState>
        )}
      </div>

      {detail && (
        <IncidentModal
          id={detail}
          onClose={() => setDetail(null)}
          onChanged={() => {
            events.reload();
            stats.reload();
          }}
        />
      )}
    </div>
  );
}

interface SecStats {
  fire_today: number;
  smoke_today: number;
  security_today: number;
  unauthorized_entry: number;
  after_hours: number;
  potential_theft: number;
  critical_incidents: number;
  open_incidents: number;
}

function IncidentModal({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const detail = useApi(() =>
    api.get<{ event: SecEvent; detections: unknown[]; evidence: { id: string; kind: string }[] }>(`/events/${id}`),
  );
  const notes = useApi(() => api.get<{ notes: Note[] }>(`/events/${id}/notes`));
  const [note, setNote] = useState('');
  const [evUrl, setEvUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setStatus = async (status: string) => {
    setBusy(true);
    await api.patch(`/events/${id}/status`, { status }).catch(() => undefined);
    setBusy(false);
    detail.reload();
    onChanged();
  };

  const addNote = async () => {
    if (!note.trim()) return;
    await api.post(`/events/${id}/notes`, { note });
    setNote('');
    notes.reload();
  };

  const loadEvidence = async (evidenceId: string) => {
    const r = await api.get<{ evidence: { url: string } }>(`/events/${id}/evidence/${evidenceId}/url`);
    setEvUrl(r.evidence.url);
  };

  return (
    <Modal title="Incident management" onClose={onClose}>
      {detail.loading || !detail.data ? (
        <Loading />
      ) : (
        <div>
          <div className="kv">
            <div>Incident</div><div>{eventLabel(detail.data.event.event_type)}</div>
            <div>Severity</div><div><Badge kind={detail.data.event.severity}>{detail.data.event.severity}</Badge></div>
            <div>Confidence</div><div>{Math.round((detail.data.event.confidence ?? 0) * 100)}%</div>
            <div>Status</div><div><Badge kind={detail.data.event.status}>{detail.data.event.status}</Badge></div>
          </div>

          <h4>Evidence</h4>
          {detail.data.evidence.length === 0 ? (
            <p className="muted">No evidence captured.</p>
          ) : (
            detail.data.evidence.map((ev) => (
              <button key={ev.id} className="btn secondary small" style={{ marginRight: 8, marginBottom: 8 }} onClick={() => loadEvidence(ev.id)}>
                Load {ev.kind} (signed URL)
              </button>
            ))
          )}
          {evUrl && <img src={evUrl} alt="evidence" style={{ maxWidth: '100%', border: '1px solid var(--border)', borderRadius: 8, marginTop: 8 }} />}

          <h4>Workflow</h4>
          <div className="row-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
            <button className="btn secondary small" disabled={busy} onClick={() => setStatus('ACKNOWLEDGED')}>Acknowledge</button>
            <button className="btn secondary small" disabled={busy} onClick={() => setStatus('INVESTIGATING')}>Investigate</button>
            <button className="btn small" disabled={busy} onClick={() => setStatus('RESOLVED')}>Resolve</button>
            <button className="btn secondary small" disabled={busy} onClick={() => setStatus('FALSE_POSITIVE')}>False positive</button>
            <button className="btn secondary small" disabled={busy} onClick={() => setStatus('DISMISSED')}>Dismiss</button>
          </div>

          <h4>Notes</h4>
          <div className="row-actions">
            <input className="input" placeholder="Add investigation note…" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="btn" onClick={addNote} disabled={!note.trim()}>Add</button>
          </div>
          <div style={{ marginTop: 10 }}>
            {notes.loading ? (
              <Loading />
            ) : notes.data && notes.data.notes.length > 0 ? (
              notes.data.notes.map((n) => (
                <div key={n.id} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
                  <div>{n.note}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{n.author_email ?? 'system'} · {new Date(n.created_at).toLocaleString()}</div>
                </div>
              ))
            ) : (
              <p className="muted">No notes yet.</p>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

interface Note { id: string; note: string; created_at: string; author_email: string | null; }
