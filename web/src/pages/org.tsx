import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, EmptyState, ErrorBox, Loading, StatCard, useApi } from '../components';

// ---------------- Reports ----------------
export function Reports() {
  const reports = useApi(() => api.get<{ reports: { id: string; name: string; kind: string; created_at: string }[] }>('/reports'));
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const create = async () => {
    if (!name) return;
    await api.post('/reports', { name, kind: 'EVENT_SUMMARY', params: {} });
    setName('');
    reports.reload();
  };

  return (
    <div>
      <div className="toolbar">
        <div><h1 className="page-title">Reports</h1><p className="page-sub">Analytics & exports — always scoped to this organization.</p></div>
        <a className="btn secondary" href="/api/reports/export/events.csv">Export events CSV</a>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Saved reports</h3>
          {reports.loading ? <Loading /> : reports.data && reports.data.reports.length > 0 ? (
            <table>
              <thead><tr><th>Name</th><th>Kind</th><th></th></tr></thead>
              <tbody>
                {reports.data.reports.map((r) => (
                  <tr key={r.id}><td>{r.name}</td><td>{r.kind}</td><td><button className="btn secondary small" onClick={() => setSelected(r.id)}>Run</button></td></tr>
                ))}
              </tbody>
            </table>
          ) : <EmptyState>No reports yet.</EmptyState>}
          <h4>New report</h4>
          <div className="row-actions">
            <input className="input" placeholder="Report name" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn" onClick={create}>Create</button>
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Report data</h3>
          {selected ? <ReportData id={selected} /> : <EmptyState>Select a report to view analytics.</EmptyState>}
        </div>
      </div>

      {/* Fire & Safety and Security reports (ADD-ON) — tenant scoped. */}
      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <FireSafetyReport />
        <SecurityReport />
      </div>
    </div>
  );
}

function FireSafetyReport() {
  const { data, loading } = useApi(() => api.get<FirePayload>('/reports/fire-safety/data'));
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Fire &amp; Safety Report</h3>
      {loading || !data ? (
        <Loading />
      ) : (
        <>
          <div className="grid cols-2">
            <StatCard label="Fire events" value={data.totals.fire_events} tone="crit" />
            <StatCard label="Smoke events" value={data.totals.smoke_events} tone="warn" />
            <StatCard label="Fire + Smoke" value={data.totals.fire_and_smoke_events} tone="crit" />
            <StatCard label="Resolved" value={data.totals.resolved} tone="accent" />
          </div>
          {data.bySite.length > 0 && (
            <>
              <h4>By site</h4>
              <table><tbody>{data.bySite.map((r) => <tr key={r.site}><td>{r.site}</td><td>{r.count}</td></tr>)}</tbody></table>
            </>
          )}
        </>
      )}
    </div>
  );
}
interface FirePayload {
  totals: { fire_events: number; smoke_events: number; fire_and_smoke_events: number; critical_incidents: number; resolved: number };
  byCamera: { camera: string; count: number }[];
  bySite: { site: string; count: number }[];
}

function SecurityReport() {
  const { data, loading } = useApi(() => api.get<SecReportPayload>('/reports/security/data'));
  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Security Report</h3>
      {loading || !data ? (
        <Loading />
      ) : (
        <>
          <div className="grid cols-2">
            <StatCard label="Unauthorized entries" value={data.totals.unauthorized_entries} tone="warn" />
            <StatCard label="After-hours" value={data.totals.after_hours} tone="warn" />
            <StatCard label="Object removed" value={data.totals.object_removed} tone="warn" />
            <StatCard label="Unauthorized vehicle" value={data.totals.unauthorized_vehicle} />
            <StatCard label="Restricted zone" value={data.totals.restricted_zone} tone="warn" />
            <StatCard label="Resolved" value={data.totals.resolved} tone="accent" />
          </div>
        </>
      )}
    </div>
  );
}
interface SecReportPayload {
  totals: { unauthorized_entries: number; after_hours: number; object_removed: number; unauthorized_vehicle: number; restricted_zone: number; resolved: number };
  bySite: { site: string; count: number }[];
}

function ReportData({ id }: { id: string }) {
  const { data, loading } = useApi(() => api.get<ReportPayload>(`/reports/${id}/data`), [id]);
  if (loading || !data) return <Loading />;
  return (
    <div>
      <div className="grid cols-2">
        <StatCard label="Total events" value={data.totals.total_events} />
        <StatCard label="Open events" value={data.totals.open_events} tone="warn" />
        <StatCard label="Cameras" value={data.totals.cameras} />
        <StatCard label="Sites" value={data.totals.sites} />
      </div>
      <h4>By type</h4>
      <table><tbody>{data.byType.map((t) => <tr key={t.event_type}><td>{t.event_type}</td><td>{t.count}</td></tr>)}</tbody></table>
    </div>
  );
}
interface ReportPayload {
  totals: { total_events: number; open_events: number; cameras: number; sites: number };
  byType: { event_type: string; count: number }[];
  bySeverity: { severity: string; count: number }[];
}

// ---------------- Users & Roles ----------------
export function Users() {
  const members = useApi(() => api.get<{ members: Member[] }>('/members'));
  const [form, setForm] = useState({ email: '', role: 'VIEWER' });
  const [err, setErr] = useState<unknown>(null);

  const invite = async () => {
    setErr(null);
    try {
      await api.post('/members', form);
      setForm({ email: '', role: 'VIEWER' });
      members.reload();
    } catch (e) { setErr(e); }
  };

  return (
    <div>
      <h1 className="page-title">Users & Roles</h1>
      <p className="page-sub">Members of this organization. Roles: Owner ▸ Admin ▸ Operator ▸ Viewer.</p>
      <div className="card">
        {members.loading ? <Loading /> : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {members.data?.members.map((m) => (
                <tr key={m.id}>
                  <td>{m.full_name}</td>
                  <td className="muted">{m.email}</td>
                  <td>
                    <select className="input" style={{ maxWidth: 140 }} value={m.role} onChange={async (e) => { await api.patch(`/members/${m.id}`, { role: e.target.value }); members.reload(); }}>
                      {['OWNER', 'ADMIN', 'OPERATOR', 'VIEWER'].map((r) => <option key={r}>{r}</option>)}
                    </select>
                  </td>
                  <td><Badge kind={m.status}>{m.status}</Badge></td>
                  <td><button className="btn secondary small" onClick={async () => { await api.del(`/members/${m.id}`).catch(() => undefined); members.reload(); }}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <h4>Invite member</h4>
        <div className="row-actions">
          <input className="input" placeholder="email@company.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <select className="input" style={{ maxWidth: 160 }} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {['ADMIN', 'OPERATOR', 'VIEWER'].map((r) => <option key={r}>{r}</option>)}
          </select>
          <button className="btn" onClick={invite} disabled={!form.email}>Invite</button>
        </div>
        <ErrorBox error={err} />
      </div>
    </div>
  );
}
interface Member { id: string; user_id: string; full_name: string; email: string; role: string; status: string; }

// ---------------- Billing ----------------
export function Billing() {
  const sub = useApi(() => api.get<{ subscription: Sub | null }>('/billing/subscription'));
  const invoices = useApi(() => api.get<{ invoices: Invoice[] }>('/billing/invoices'));

  const changePlan = async (plan: string) => {
    await api.post('/billing/subscription/plan', { plan }).catch(() => undefined);
    sub.reload();
  };

  return (
    <div>
      <h1 className="page-title">Billing</h1>
      <p className="page-sub">Your plan, usage and invoices. Never shows other organizations.</p>
      {sub.loading ? <Loading /> : sub.data?.subscription && (
        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <StatCard label="Plan" value={sub.data.subscription.plan} />
          <StatCard label="Status" value={<Badge kind={sub.data.subscription.status === 'ACTIVE' ? 'ACTIVE' : 'MEDIUM'}>{sub.data.subscription.status}</Badge>} />
          <StatCard label="Cameras used" value={`${sub.data.subscription.cameras_used} / ${sub.data.subscription.camera_limit}`} />
          <StatCard label="Renews" value={sub.data.subscription.current_period_end ? new Date(sub.data.subscription.current_period_end).toLocaleDateString() : '—'} />
        </div>
      )}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Change plan</h3>
        <div className="row-actions">
          {['STARTER', 'GROWTH', 'ENTERPRISE'].map((p) => <button key={p} className="btn secondary" onClick={() => changePlan(p)}>{p}</button>)}
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>Invoices</h3>
        {invoices.loading ? <Loading /> : invoices.data && invoices.data.invoices.length > 0 ? (
          <table>
            <thead><tr><th>Number</th><th>Status</th><th>Amount</th><th>Period</th></tr></thead>
            <tbody>
              {invoices.data.invoices.map((i) => (
                <tr key={i.id}><td>{i.number}</td><td><Badge kind={i.status === 'PAID' ? 'ACTIVE' : 'MEDIUM'}>{i.status}</Badge></td><td>${(i.amount_cents / 100).toFixed(2)}</td><td className="muted">{i.period_start ? new Date(i.period_start).toLocaleDateString() : '—'}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState>No invoices yet — you're on a trial.</EmptyState>}
      </div>
    </div>
  );
}
interface Sub { plan: string; status: string; camera_limit: number; cameras_used: number; current_period_end: string | null; }
interface Invoice { id: string; number: string; status: string; amount_cents: number; period_start: string | null; }

// ---------------- Audit ----------------
export function Audit() {
  const { data, loading } = useApi(() => api.get<{ auditLogs: AuditLog[] }>('/audit-logs'));
  return (
    <div>
      <h1 className="page-title">Audit Logs</h1>
      <p className="page-sub">Every action in your organization. Only your organization's logs are visible.</p>
      <div className="card">
        {loading ? <Loading /> : data && data.auditLogs.length > 0 ? (
          <table>
            <thead><tr><th>When</th><th>User</th><th>Action</th><th>Resource</th><th>ID</th></tr></thead>
            <tbody>
              {data.auditLogs.map((a) => (
                <tr key={a.id}><td className="muted">{new Date(a.created_at).toLocaleString()}</td><td>{a.user_email ?? '—'}</td><td><span className="pill">{a.action}</span></td><td>{a.resource}</td><td className="muted">{a.resource_id?.slice(0, 8) ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <EmptyState>No audit activity yet.</EmptyState>}
      </div>
    </div>
  );
}
interface AuditLog { id: string; created_at: string; user_email: string | null; action: string; resource: string; resource_id: string | null; }

// ---------------- Settings ----------------
export function Settings() {
  const { user, activeOrganization } = useAuth();
  return (
    <div>
      <h1 className="page-title">Settings</h1>
      <p className="page-sub">Account and organization details.</p>
      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Account</h3>
          <div className="kv">
            <div>Name</div><div>{user?.fullName}</div>
            <div>Email</div><div>{user?.email}</div>
            <div>Platform admin</div><div>{user?.isPlatformAdmin ? 'Yes' : 'No'}</div>
          </div>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Organization</h3>
          <div className="kv">
            <div>Name</div><div>{activeOrganization?.organizationName}</div>
            <div>Your role</div><div><Badge kind="role">{activeOrganization?.role}</Badge></div>
            <div>Org ID</div><div className="muted" style={{ fontSize: 12 }}>{activeOrganization?.organizationId}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Onboarding ----------------
export function Onboarding() {
  const steps = [
    ['Create a site', 'Add the physical location you want to monitor.', '/app/sites'],
    ['Add a camera', 'Connect an RTSP camera — credentials are encrypted server-side.', '/app/cameras'],
    ['Test the camera', 'Verify connectivity from the Cameras page.', '/app/cameras'],
    ['Configure AI', 'Enable detection models on your cameras.', '/app/events'],
    ['Set up alerts', 'Create notification rules for your team.', '/app/alerts'],
    ['Start monitoring', 'Watch the live dashboard.', '/app'],
  ] as const;
  return (
    <div>
      <h1 className="page-title">Welcome to SentriAI 🎉</h1>
      <p className="page-sub">Let's get your isolated workspace set up in a few steps.</p>
      <div className="grid cols-3" style={{ marginTop: 16 }}>
        {steps.map(([t, d, to], i) => (
          <div className="card" key={t}>
            <div className="pill">Step {i + 1}</div>
            <h3>{t}</h3>
            <p className="muted">{d}</p>
            <Link className="btn secondary small" to={to}>Go</Link>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 20 }}><Link className="btn" to="/app">Skip to dashboard</Link></div>
    </div>
  );
}

// ---------------- Platform Admin ----------------
export function Platform() {
  const { data, loading, error } = useApi(() => api.get<PlatformOverview>('/platform/overview'));
  return (
    <div>
      <h1 className="page-title">Platform Admin</h1>
      <p className="page-sub">Aggregate platform view. Requires the PLATFORM_ADMIN role.</p>
      <ErrorBox error={error} />
      {loading ? <Loading /> : data && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <StatCard label="Organizations" value={data.totals.organizations} />
            <StatCard label="Cameras" value={data.totals.cameras} />
            <StatCard label="Events" value={data.totals.events} />
            <StatCard label="Users" value={data.totals.users} />
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Organizations</h3>
            <table>
              <thead><tr><th>Name</th><th>Plan</th><th>Status</th><th>Cameras</th><th>Demo</th></tr></thead>
              <tbody>
                {data.organizations.map((o) => (
                  <tr key={o.id}><td>{o.name}</td><td>{o.plan ?? '—'}</td><td>{o.status ?? '—'}</td><td>{o.cameras}</td><td>{o.is_demo ? 'Yes' : ''}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
interface PlatformOverview {
  totals: { organizations: number; cameras: number; events: number; users: number };
  organizations: { id: string; name: string; plan: string | null; status: string | null; cameras: number; is_demo: boolean }[];
}
