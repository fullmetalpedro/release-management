import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  COLUMNS,
  OpenColumn,
  ReviewerScopeToggle,
  type ColumnId,
  type ReviewerScope,
} from '../components/board';
import { MergedColumn, ReleaseColumn, type CreateState } from '../components/lanes';
import { useToast } from '../components/toast';
import {
  AuthorIcon,
  ColumnsDropdown,
  FilterSelect,
  ProjectSwitcher,
  RepositoryIcon,
  SearchBox,
  SyncControls,
  TargetIcon,
} from '../components/toolbar';
import { TopBar } from '../components/TopBar';
import { api, ApiError, type BoardColumnId, type PullRequestCard } from '../lib/api';
import { elapsedLabel, plural, useNow, useStoredState } from '../lib/format';
import { LANE_STALE_MS, laneKey, SYNC_INTERVAL_MS, useAllLanes } from '../lib/lanes';
import { useSession } from '../lib/session';

const OPEN_COLUMNS: BoardColumnId[] = ['dependsOnMe', 'review', 'conflict', 'ready'];

// Valor do filtro de autor para "os meus PRs"; os demais autores são filtrados pelo nome.
const AUTHOR_ME = '@me';

export function BoardPage() {
  const { me, project, projects, projectsLoading, selectProject } = useSession();
  const projectId = project?.id;
  const now = useNow();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [repositoryFilter, setRepositoryFilter] = useState<string | null>(null);
  const [targetFilter, setTargetFilter] = useState<string | null>(null);
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hidden, setHidden] = useStoredState<ColumnId[]>('rm.hiddenColumns', []);
  const [laneRepos, setLaneRepos] = useStoredState<Record<string, { merged?: string; release?: string }>>('rm.laneRepos', {});
  const [reviewerScope, setReviewerScope] = useStoredState<ReviewerScope>('rm.reviewerScope', 'all');
  const [createState, setCreateState] = useState<CreateState>({ status: 'idle' });
  const [justCreated, setJustCreated] = useState(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Filtros de repositório e destino só fazem sentido dentro do projeto em que foram escolhidos.
  useEffect(() => {
    setRepositoryFilter(null);
    setTargetFilter(null);
    // "Você" vale em qualquer projeto; um colega escolhido pelo nome pode nem existir no outro.
    setAuthorFilter((current) => (current === AUTHOR_ME ? current : null));
    setCreateState({ status: 'idle' });
  }, [projectId]);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  const board = useQuery({
    queryKey: ['board', projectId],
    queryFn: () => api.board(projectId!),
    enabled: !!projectId,
    refetchInterval: SYNC_INTERVAL_MS,
    retry: false,
  });

  const repositories = board.data?.repositories ?? [];
  const chosen = (projectId && laneRepos[projectId]) || {};
  const pick = (id: string | undefined) => (repositories.some((r) => r.id === id) ? id : repositories[0]?.id);
  const mergedRepo = pick(chosen.merged);
  const releaseRepo = pick(chosen.release);
  const setLaneRepo = (lane: 'merged' | 'release', id: string) => {
    if (projectId) setLaneRepos({ ...laneRepos, [projectId]: { ...chosen, [lane]: id } });
  };

  // Todas as raias chegam juntas no primeiro carregamento; trocar de repositório só lê o cache.
  // A busca individual fica para o repositório que falhou no lote e para depois de criar uma release.
  const allLanes = useAllLanes(projectId);
  const laneOptions = (repositoryId: string | undefined) => ({
    queryKey: laneKey(projectId, repositoryId),
    queryFn: () => api.lane(projectId!, repositoryId!),
    enabled: !!projectId && !!repositoryId && allLanes.isFetched,
    staleTime: LANE_STALE_MS,
    gcTime: 3 * LANE_STALE_MS,
    retry: false,
  });
  const mergedLane = useQuery(laneOptions(mergedRepo));
  const releaseLane = useQuery(laneOptions(releaseRepo));

  const create = useMutation({
    mutationFn: (input: { repositoryId: string; name: string; pullRequestIds: number[] }) =>
      api.createRelease(projectId!, input.repositoryId, input.name, input.pullRequestIds),
    onMutate: () => setCreateState({ status: 'creating' }),
    onSuccess: async (created, input) => {
      setLaneRepo('release', input.repositoryId);
      await queryClient.invalidateQueries({ queryKey: ['lane', projectId] });
      setCreateState({ status: 'idle' });
      setJustCreated(true);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setJustCreated(false), 9000);
      toast.show({
        kind: 'success',
        title: `Branch ${created.name} criada`,
        description: `${plural(created.pullRequests, 'PR incluído', 'PRs incluídos')} via cherry-pick em ${created.repository}.`,
        action: {
          label: 'Ver release',
          onClick: () =>
            navigate(`/release?repo=${encodeURIComponent(input.repositoryId)}&branch=${encodeURIComponent(created.name)}`),
        },
      });
    },
    onError: (error, input) => {
      const conflict = error instanceof ApiError && error.code === 'cherry-pick-conflict';
      const conflictingId = conflict ? Number(error.details.pullRequestId) : undefined;
      setCreateState({ status: 'failed', conflictingId });
      toast.show({
        kind: 'error',
        title: 'Não foi possível criar a branch',
        description: conflict
          ? `Conflito ao aplicar #${conflictingId} sobre ${String(error.details.baseBranch)}. Remova o PR da seleção ou resolva o conflito.`
          : error.message,
        action: { label: 'Tentar novamente', onClick: () => create.mutate(input) },
      });
    },
  });

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matches = (pr: PullRequestCard) =>
      (!authorFilter || (authorFilter === AUTHOR_ME ? pr.author.isMe : !pr.author.isMe && pr.author.name === authorFilter)) &&
      (!repositoryFilter || pr.repository.id === repositoryFilter) &&
      (!targetFilter || pr.targetBranch === targetFilter) &&
      (!term ||
        pr.title.toLowerCase().includes(term) ||
        `#${pr.id}`.includes(term) ||
        pr.author.name.toLowerCase().includes(term) ||
        (pr.author.isMe && 'você'.includes(term)));
    const columns = board.data?.columns;
    const result = Object.fromEntries(OPEN_COLUMNS.map((id) => [id, (columns?.[id] ?? []).filter(matches)])) as Record<
      BoardColumnId,
      PullRequestCard[]
    >;
    // "Só obrigatório" esconde os PRs em que sou revisor opcional; os que aguardam o autor continuam.
    if (reviewerScope === 'required') {
      result.dependsOnMe = result.dependsOnMe.filter((pr) => pr.reason !== 'reviewer' || pr.requiredReviewer);
    }
    return result;
  }, [board.data, authorFilter, repositoryFilter, targetFilter, search, reviewerScope]);

  const allOpen = useMemo(() => OPEN_COLUMNS.flatMap((id) => board.data?.columns[id] ?? []), [board.data]);
  const targets = useMemo(
    () => [...new Set(allOpen.map((pr) => pr.targetBranch))].sort().map((name) => ({ id: name, name })),
    [allOpen],
  );
  // "Você" primeiro, depois os colegas com PR aberto, em ordem alfabética.
  const authors = useMemo(() => {
    const others = new Map(allOpen.filter((pr) => !pr.author.isMe).map((pr) => [pr.author.name, pr.author]));
    return [
      { id: AUTHOR_ME, name: 'Você', person: { name: me.user.name, isMe: true, avatarKey: me.user.avatarKey } },
      ...[...others.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((author) => ({ id: author.name, name: author.name, person: author })),
    ];
  }, [allOpen, me.user.name, me.user.avatarKey]);
  const dependsOnMe = (board.data?.columns.dependsOnMe ?? []).filter(
    (pr) => reviewerScope === 'all' || pr.reason !== 'reviewer' || pr.requiredReviewer,
  ).length;
  const optionalHidden =
    reviewerScope === 'required' &&
    (board.data?.columns.dependsOnMe ?? []).some((pr) => pr.reason === 'reviewer' && !pr.requiredReviewer);
  const isFiltered =
    !!repositoryFilter || !!targetFilter || !!authorFilter || search.trim() !== '';

  const loading = !board.data && (board.isPending || projectsLoading) && !board.isError;
  const syncing = board.isFetching || allLanes.isFetching || mergedLane.isFetching || releaseLane.isFetching;
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void board.refetch();
    void allLanes.refetch();
  };

  const counts: Partial<Record<ColumnId, number>> = board.data
    ? {
        ...Object.fromEntries(OPEN_COLUMNS.map((id) => [id, filtered[id].length])),
        merged: mergedLane.data?.merged.length,
        release: releaseLane.data?.release?.pullRequests.length,
      }
    : {};
  const show = (id: ColumnId) => !hidden.includes(id);

  return (
    <div data-page="board" className="flex h-full min-h-[560px] flex-col">
      <TopBar />

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 px-8 pb-5 pt-7">
        <div className="flex flex-col gap-2.5">
          <ProjectSwitcher projects={projects} current={project} loading={projectsLoading} onSelect={selectProject} />
          <h1 className="text-2xl font-bold tracking-[-0.3px] text-ink">Code review</h1>
          <div className="flex h-4 items-center gap-2 text-[13px]">
            {loading || !board.data ? null : (
              <>
                <span className="font-medium text-ink-2">
                  {plural(allOpen.length, 'PR aberto', 'PRs abertos')}
                </span>
                <span className="text-[#CBD5E1]">·</span>
                {dependsOnMe > 0 ? (
                  <span className="font-semibold text-[#B45309]">
                    {plural(dependsOnMe, 'depende de você', 'dependem de você')}
                  </span>
                ) : (
                  <span className="font-semibold text-[#16A34A]">Nada depende de você</span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2.5">
          <FilterSelect
            icon={AuthorIcon}
            label="Autor"
            allLabel="todos"
            options={authors}
            value={authorFilter}
            onChange={setAuthorFilter}
            plain
          />
          <FilterSelect
            icon={RepositoryIcon}
            label="Repositório"
            allLabel="todos"
            options={repositories}
            value={repositoryFilter}
            onChange={setRepositoryFilter}
          />
          <FilterSelect
            icon={TargetIcon}
            label="Destino"
            allLabel="todas"
            options={targets}
            value={targetFilter}
            onChange={setTargetFilter}
          />
          <ColumnsDropdown hidden={hidden} counts={counts} onChange={setHidden} />
          <SearchBox value={search} onChange={setSearch} />
          <SyncControls
            syncing={syncing}
            failed={board.isError}
            lastSync={board.data && elapsedLabel(board.data.syncedAt, now)}
            onRefresh={refresh}
          />
        </div>
      </div>

      {/* O board não rola na vertical: cada coluna cuida do próprio conteúdo. */}
      <main className="column-scroll flex min-h-0 flex-1 items-start gap-4 overflow-x-auto overflow-y-hidden px-8 pb-8">
        {COLUMNS.filter((column) => show(column.id)).map((column) => {
          if (column.id === 'merged') {
            return (
              <MergedColumn
                key={column.id}
                repositories={repositories}
                repositoryId={mergedRepo}
                onRepositoryChange={(id) => {
                  setLaneRepo('merged', id);
                  setCreateState({ status: 'idle' });
                }}
                lane={mergedLane.data}
                loading={loading || (!mergedLane.data && !!mergedRepo && (allLanes.isPending || mergedLane.isFetching))}
                state={createState}
                onSelectionChange={() => createState.status === 'failed' && setCreateState({ status: 'idle' })}
                onCreate={(name, pullRequestIds) =>
                  mergedRepo && create.mutate({ repositoryId: mergedRepo, name, pullRequestIds })
                }
              />
            );
          }
          if (column.id === 'release') {
            return (
              <ReleaseColumn
                key={column.id}
                repositories={repositories}
                repositoryId={releaseRepo}
                onRepositoryChange={(id) => setLaneRepo('release', id)}
                lane={releaseLane.data}
                loading={loading || (!releaseLane.data && !!releaseRepo && (allLanes.isPending || releaseLane.isFetching))}
                highlight={justCreated}
                now={now}
              />
            );
          }
          return (
            <OpenColumn
              key={column.id}
              id={column.id}
              cards={filtered[column.id]}
              loading={loading}
              emptyState={!!board.data && !isFiltered && !(column.id === 'dependsOnMe' && optionalHidden)}
              filtered={isFiltered || (column.id === 'dependsOnMe' && optionalHidden)}
              emptyNote={
                column.id === 'dependsOnMe' && optionalHidden && !isFiltered
                  ? 'Nenhum PR em que você é revisor obrigatório.'
                  : undefined
              }
              controls={
                column.id === 'dependsOnMe' && !loading ? (
                  <ReviewerScopeToggle value={reviewerScope} onChange={setReviewerScope} />
                ) : undefined
              }
              now={now}
            />
          );
        })}
      </main>
    </div>
  );
}
