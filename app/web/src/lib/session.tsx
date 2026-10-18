import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError, type Me, type ProjectView } from './api';
import { useStoredState } from './format';

// Valor guardado em rm.project quando o board mostra todos os projetos da organização.
export const ALL_PROJECTS = '*';

interface SessionContextValue {
  me: Me;
  projects: ProjectView[];
  projectsLoading: boolean;
  // O projeto escolhido; com "Todos os projetos", o primeiro da lista, para as telas que precisam de um.
  project: ProjectView | undefined;
  // "Todos os projetos" escolhido, numa organização com mais de um.
  allProjects: boolean;
  selectProject: (id: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, retry: false, staleTime: 5 * 60_000 });
}

// Só renderiza as páginas internas com sessão válida; um 401 posterior derruba para o login, a não ser que só o token
// de uma organização tenha caído (aí o menu de contas pede para reconectar).
export function RequireSession({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  const queryClient = useQueryClient();
  // No modo token o projeto escolhido por último fica guardado por organização: trocar de organização restaura o dela.
  const connectionId = me.data?.accounts.find((account) => account.active)?.id;
  const [projectId, setProjectId] = useStoredState<string | null>(connectionId ? `rm.project:${connectionId}` : 'rm.project', null);

  const projects = useQuery({
    queryKey: ['projects', connectionId],
    queryFn: api.projects,
    enabled: me.isSuccess,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Uma escrita recusada por token só de leitura: a sessão recarrega para a interface desabilitar a ação.
  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        const error = event.mutation?.state.error;
        if (event.type === 'updated' && error instanceof ApiError && error.code === 'read-only') {
          void queryClient.invalidateQueries({ queryKey: ['me'] });
        }
      }),
    [queryClient],
  );

  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        const error = event.query.state.error;
        const expired = error instanceof ApiError && error.status === 401;
        if (event.type !== 'updated' || !expired || event.query.queryKey[0] === 'me') return;
        // Só o token de uma organização caiu: a sessão continua, e o menu de contas passa a pedir a reconexão dela.
        if (error.code === 'connection-expired') void queryClient.invalidateQueries({ queryKey: ['me'] });
        else void queryClient.resetQueries({ queryKey: ['me'] });
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
      allProjects: projectId === ALL_PROJECTS && list.length > 1,
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
