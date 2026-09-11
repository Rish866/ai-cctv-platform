import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './styles.css';
import { AuthProvider, useAuth } from './auth';
import { Loading } from './components';
import { Shell } from './Shell';
import { ForgotPassword, Landing, Login, Signup } from './pages/public';
import { Dashboard } from './pages/dashboard';
import { Cameras, Sites } from './pages/sites';
import { Events } from './pages/events';
import { Alerts, LiveMonitoring } from './pages/monitoring';
import { Audit, Billing, Onboarding, Platform, Reports, Settings, Users } from './pages/org';
import { SecurityCenter } from './pages/security';

/** Route guard: requires an authenticated user (fail closed -> redirect to login). */
function Protected({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Redirect authenticated users away from public auth pages. */
function PublicOnly({ children }: { children: ReactNode }) {
  const { loading, user } = useAuth();
  if (loading) return <Loading />;
  if (user) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          <Route path="/signup" element={<PublicOnly><Signup /></PublicOnly>} />
          <Route path="/forgot-password" element={<PublicOnly><ForgotPassword /></PublicOnly>} />
          <Route path="/onboarding" element={<Protected><Onboarding /></Protected>} />
          <Route path="/app" element={<Protected><Shell /></Protected>}>
            <Route index element={<Dashboard />} />
            <Route path="live" element={<LiveMonitoring />} />
            <Route path="events" element={<Events />} />
            <Route path="security" element={<SecurityCenter />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="sites" element={<Sites />} />
            <Route path="cameras" element={<Cameras />} />
            <Route path="reports" element={<Reports />} />
            <Route path="users" element={<Users />} />
            <Route path="billing" element={<Billing />} />
            <Route path="audit" element={<Audit />} />
            <Route path="settings" element={<Settings />} />
            <Route path="platform" element={<Platform />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
