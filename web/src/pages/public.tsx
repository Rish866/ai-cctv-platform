import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { ErrorBox, Spinner } from '../components';
import { api } from '../api';

export function Landing() {
  return (
    <div className="public">
      <div className="nav-top">
        <div className="brand"><span className="dot" /> GarudAI</div>
        <div style={{ display: 'flex', gap: 12 }}>
          <Link className="btn secondary" to="/login">Sign in</Link>
          <Link className="btn" to="/signup">Start free trial</Link>
        </div>
      </div>
      <section className="hero">
        <h1>AI CCTV monitoring<br />that never mixes tenants.</h1>
        <p>
          GarudAI turns your existing cameras into an intelligent monitoring platform — person &
          vehicle detection, intrusion, PPE compliance, and more. Every customer gets a fully
          isolated workspace, enforced all the way down to the database.
        </p>
        <div className="cta">
          <Link className="btn" to="/signup">Create your organization</Link>
          <Link className="btn secondary" to="/login">Sign in</Link>
        </div>
      </section>
      <div className="features">
        {[
          ['Absolute isolation', 'PostgreSQL Row Level Security + backend authorization. Tenant A can never see Tenant B.'],
          ['8 AI models', 'Person, vehicle, intrusion, line-crossing, loitering, crowd, helmet & vest detection.'],
          ['Encrypted evidence', 'Snapshots & clips stored per-tenant, served only via short-lived signed URLs.'],
          ['Real-time alerts', 'Tenant-scoped WebSocket streams and notification rules — no cross-tenant leakage.'],
        ].map(([t, d]) => (
          <div className="card" key={t}>
            <h3 style={{ marginTop: 0 }}>{t}</h3>
            <p className="muted" style={{ margin: 0 }}>{d}</p>
          </div>
        ))}
      </div>
      <p className="muted" style={{ textAlign: 'center', marginTop: 48 }}>
        © {new Date().getFullYear()} GarudAI. Built security-first.
      </p>
    </div>
  );
}

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate('/app');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: '0 0 12px' }}><span className="dot" /> GarudAI</div>
        <h2>Welcome back</h2>
        <p className="muted">Sign in to your workspace.</p>
        <label>Email</label>
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <label>Password</label>
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <ErrorBox error={error} />
        <button className="btn" style={{ width: '100%', marginTop: 16 }} disabled={busy}>
          {busy ? <Spinner /> : 'Sign in'}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14 }}>
          <Link to="/forgot-password">Forgot password?</Link>
          <Link to="/signup">Create account</Link>
        </div>
      </form>
    </div>
  );
}

export function Signup() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ fullName: '', organizationName: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signup(form);
      navigate('/onboarding');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: '0 0 12px' }}><span className="dot" /> GarudAI</div>
        <h2>Start your free trial</h2>
        <p className="muted">Create an isolated organization for your business.</p>
        <div className="form-row">
          <div>
            <label>Your name</label>
            <input className="input" value={form.fullName} onChange={set('fullName')} required />
          </div>
          <div>
            <label>Company / Organization</label>
            <input className="input" value={form.organizationName} onChange={set('organizationName')} required />
          </div>
        </div>
        <label>Work email</label>
        <input className="input" type="email" value={form.email} onChange={set('email')} required />
        <label>Password (min 8 chars)</label>
        <input className="input" type="password" value={form.password} onChange={set('password')} minLength={8} required />
        <ErrorBox error={error} />
        <button className="btn" style={{ width: '100%', marginTop: 16 }} disabled={busy}>
          {busy ? <Spinner /> : 'Create organization'}
        </button>
        <div style={{ marginTop: 14 }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </div>
      </form>
    </div>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await api.post('/auth/forgot-password', { email }).catch(() => undefined);
    setBusy(false);
    setDone(true);
  };

  return (
    <div className="auth-wrap">
      <form className="card auth-card" onSubmit={submit}>
        <div className="brand" style={{ padding: '0 0 12px' }}><span className="dot" /> GarudAI</div>
        <h2>Reset password</h2>
        {done ? (
          <p className="success">If an account exists for that email, a reset link has been sent.</p>
        ) : (
          <>
            <p className="muted">Enter your email and we'll send a reset link.</p>
            <label>Email</label>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <button className="btn" style={{ width: '100%', marginTop: 16 }} disabled={busy}>
              {busy ? <Spinner /> : 'Send reset link'}
            </button>
          </>
        )}
        <div style={{ marginTop: 14 }}><Link to="/login">Back to sign in</Link></div>
      </form>
    </div>
  );
}
