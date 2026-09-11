import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';

const NAV = [
  { section: 'Monitoring' },
  { to: '/app', label: 'Dashboard', end: true },
  { to: '/app/live', label: 'Live Monitoring' },
  { to: '/app/events', label: 'AI Events' },
  { to: '/app/security', label: 'Security Center' },
  { to: '/app/alerts', label: 'Alerts' },
  { section: 'Infrastructure' },
  { to: '/app/sites', label: 'Sites & Zones' },
  { to: '/app/cameras', label: 'Cameras' },
  { to: '/app/reports', label: 'Reports' },
  { section: 'Organization' },
  { to: '/app/users', label: 'Users & Roles' },
  { to: '/app/billing', label: 'Billing' },
  { to: '/app/audit', label: 'Audit Logs' },
  { to: '/app/settings', label: 'Settings' },
];

export function Shell() {
  const { user, organizations, activeOrganization, switchOrg, logout } = useAuth();
  const navigate = useNavigate();

  const initials = (user?.fullName ?? '?')
    .split(' ')
    .map((s) => s[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="dot" /> GarudAI
        </div>
        <nav className="nav">
          {NAV.map((item, i) =>
            'section' in item ? (
              <div className="section" key={`s-${i}`}>{item.section}</div>
            ) : (
              <NavLink key={item.to} to={item.to!} end={item.end}>
                {item.label}
              </NavLink>
            ),
          )}
          {user?.isPlatformAdmin && (
            <>
              <div className="section">Platform</div>
              <NavLink to="/app/platform">Platform Admin</NavLink>
            </>
          )}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="orgswitch">
            <span className="muted">Organization</span>
            <select
              className="input"
              value={activeOrganization?.organizationId ?? ''}
              onChange={(e) => void switchOrg(e.target.value)}
            >
              {organizations.map((o) => (
                <option key={o.organizationId} value={o.organizationId}>
                  {o.organizationName} — {o.role}
                </option>
              ))}
            </select>
          </div>
          <div className="header-actions">
            {activeOrganization && <span className="badge role">{activeOrganization.role}</span>}
            <div className="avatar" title={user?.email}>{initials}</div>
            <button
              className="btn secondary small"
              onClick={async () => {
                await logout();
                navigate('/login');
              }}
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
