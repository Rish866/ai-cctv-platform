import { api } from '../api';
import { Badge, EmptyState, ErrorBox, Loading, StatCard, useApi } from '../components';

interface Stats {
  total_cameras: number;
  online_cameras: number;
  offline_cameras: number;
  events_today: number;
  critical_events: number;
  unresolved_events: number;
  site_count: number;
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

export function Dashboard() {
  const { data, error, loading } = useApi(() => api.get<{ stats: Stats }>('/dashboard'));
  const security = useApi(() => api.get<{ stats: SecStats }>('/dashboard/security'));
  const events = useApi(() => api.get<{ events: EventRow[] }>('/events'));

  if (loading) return <Loading />;
  return (
    <div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-sub">Live overview of your organization's monitoring.</p>
      <ErrorBox error={error} />
      {data && (
        <div className="grid cols-4" style={{ marginTop: 16 }}>
          <StatCard label="Total cameras" value={data.stats.total_cameras} />
          <StatCard label="Online" value={data.stats.online_cameras} tone="accent" />
          <StatCard label="Offline" value={data.stats.offline_cameras} tone="danger" />
          <StatCard label="Sites" value={data.stats.site_count} />
          <StatCard label="Events today" value={data.stats.events_today} />
          <StatCard label="Critical events" value={data.stats.critical_events} tone="crit" />
          <StatCard label="Unresolved" value={data.stats.unresolved_events} tone="warn" />
          <StatCard label="Resolved rate" value={`${resolvedRate(data.stats)}%`} tone="accent" />
        </div>
      )}

      {/* Safety & Security widgets (ADD-ON). Tenant-scoped counts. */}
      {security.data && (
        <>
          <h3 style={{ marginTop: 24, marginBottom: 4 }}>Safety &amp; Security</h3>
          <div className="grid cols-4">
            <StatCard label="Fire incidents today" value={security.data.stats.fire_today} tone="crit" />
            <StatCard label="Smoke incidents today" value={security.data.stats.smoke_today} tone="warn" />
            <StatCard label="Security incidents today" value={security.data.stats.security_today} />
            <StatCard label="Unauthorized entries" value={security.data.stats.unauthorized_entry} tone="warn" />
            <StatCard label="After-hours events" value={security.data.stats.after_hours} tone="warn" />
            <StatCard label="Potential theft events" value={security.data.stats.potential_theft} tone="warn" />
            <StatCard label="Critical incidents" value={security.data.stats.critical_incidents} tone="crit" />
            <StatCard label="Open incidents" value={security.data.stats.open_incidents} tone="warn" />
          </div>
        </>
      )}
      <div className="card" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>Recent events</h3>
        {events.loading ? (
          <Loading />
        ) : events.data && events.data.events.length > 0 ? (
          <table>
            <thead>
              <tr><th>Type</th><th>Severity</th><th>Camera</th><th>Site</th><th>Status</th><th>When</th></tr>
            </thead>
            <tbody>
              {events.data.events.slice(0, 8).map((e) => (
                <tr key={e.id}>
                  <td>{e.event_type}</td>
                  <td><Badge kind={e.severity}>{e.severity}</Badge></td>
                  <td>{e.camera_name}</td>
                  <td>{e.site_name}</td>
                  <td><Badge kind={e.status}>{e.status}</Badge></td>
                  <td className="muted">{new Date(e.occurred_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyState>No events yet. Add a camera and configure AI rules to start monitoring.</EmptyState>
        )}
      </div>
    </div>
  );
}

function resolvedRate(s: Stats): number {
  const total = s.events_today || 0;
  if (!total) return 100;
  const resolved = Math.max(0, total - s.unresolved_events);
  return Math.round((resolved / total) * 100);
}

export interface EventRow {
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
