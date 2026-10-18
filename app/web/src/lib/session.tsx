import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError, type Me, type ProjectView } from './api';
import { useStoredState } from './format';
import { autoSync, useSyncInterval } from './sync';

interface SessionContextValue {
  me: Me;
  projects: ProjectView[];
  projectsLoading: boolean;
  project: ProjectView | undefined;
  selectProject: (id: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: 5 * 60_000 });
}

// Só renderiza as páginas internas com sessão válida; qualquer 401 posterior derruba para o login.
export function RequireSession({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useStoredState<string | null>('rm.project', null);
  const [syncInterval] = useSyncInterval();

  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: api.projects,
    enabled: me.isSuccess,
    ...autoSync(syncInterval, 60_000),
  });

  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        const error = event.query.state.error;
        const expired = error instanceof ApiError && error.status === 401;
        if (event.type === 'updated' && expired && event.query.queryKey[0] !== 'me') {
          void queryClient.resetQueries({ queryKey: ['me'] });
        }
      }),
    [queryClient],
  );

  const value = useMemo<SessionContextValue | null>(() => {
    if (!me.data) return null;
    const list = projects.data ?? [];
    return {
      me: me.data,
      projects: list,
      projectsLoading: projects.isPending,
      project: list.find((p) => p.id === projectId) ?? list[0],
      selectProject: setProjectId,
    };
    // setProjectId muda a cada render, mas o estado que ele altera já está nas dependências.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me.data, projects.data, projects.isPending, projectId]);

  if (me.isPending) return null;
  if (!value) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession fora do RequireSession');
  return context;
}
