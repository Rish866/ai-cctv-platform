import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type CurrentUser, type Membership } from './api';

interface AuthState {
  loading: boolean;
  user: CurrentUser | null;
  organizations: Membership[];
  activeOrganization: Membership | null;
}

interface AuthContextValue extends AuthState {
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  signup: (input: { email: string; password: string; fullName: string; organizationName: string }) => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (organizationId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    loading: true,
    user: null,
    organizations: [],
    activeOrganization: null,
  });

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<{ user: CurrentUser; organizations: Membership[]; activeOrganization: Membership | null }>('/auth/me');
      setState({ loading: false, user: me.user, organizations: me.organizations, activeOrganization: me.activeOrganization });
    } catch {
      setState({ loading: false, user: null, organizations: [], activeOrganization: null });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    await api.post('/auth/login', { email, password });
    await refresh();
  }, [refresh]);

  const signup = useCallback(
    async (input: { email: string; password: string; fullName: string; organizationName: string }) => {
      await api.post('/auth/signup', input);
      await refresh();
    },
    [refresh],
  );

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => undefined);
    setState({ loading: false, user: null, organizations: [], activeOrganization: null });
  }, []);

  const switchOrg = useCallback(async (organizationId: string) => {
    await api.post('/auth/switch-org', { organizationId });
    await refresh();
  }, [refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, refresh, login, signup, logout, switchOrg }),
    [state, refresh, login, signup, logout, switchOrg],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
