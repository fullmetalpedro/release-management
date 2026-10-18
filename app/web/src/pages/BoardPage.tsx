import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownWideNarrow } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  COLUMNS,
  ColumnSlot,
  useColumnSlots,
  OpenColumn,
  PerRepositoryPlaceholder,
  ReviewerScopeToggle,
  WaitingMax,
  type ColumnId,
  type ReviewerScope,
} from '../components/board';
import { MergedColumn, ReleaseColumn, type CreateState } from '../components/lanes';
import { isHexColor, RepositoryFilter } from '../components/repoColors';
import { useToast } from '../components/toast';
import {
  AuthorIcon,
  ColumnsDropdown,
  FilterSelect,
  ProjectSwitcher,
  SearchBox,
  SyncControls,
  TargetIcon,
} from '../components/toolbar';
import { TopBar } from '../components/TopBar';
import { TriangleAlert } from 'lucide-react';
import { api, ApiError, type AllProjectsBoard, type Board, type BoardColumnId, type PullRequestCard } from '../lib/api';
import { elapsedLabel, useNow, useStoredState } from '../lib/format';
import { LANE_STALE_MS, laneKey, SYNC_INTERVAL_MS, useAllLanes } from '../lib/lanes';
import { ALL_PROJECTS, useSession } from '../lib/session';
import { t } from '../lib/i18n';
import { rem } from '../lib/units';
import { sortCards, STALE_DAYS, WAITING_COLUMNS, waitingBand, type SortOrder } from '../lib/waiting';

const OPEN_COLUMNS: BoardColumnId[] = ['dependsOnMe', 'review', 'conflict', 'ready'];

// Valor do filtro de autor para "os meus PRs"; os demais autores são filtrados pelo nome.
const AUTHOR_ME = '@me';

// Formato das preferências guardadas no navegador.
const isColumnList = (value: unknown): value is ColumnId[] =>
  Array.isArray(value) && value.every((id) => COLUMNS.some((column) => column.id === id));
const isLaneChoice = (value: unknown): value is Record<string, { merged?: string; release?: string }> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'object' && v !== null);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// Cores dos repositórios, por projeto: { projeto: { repositório: '#RRGGBB' } }.
const isColorChoice = (value: unknown): value is Record<string, Record<string, string>> =>
  isRecord(value) && Object.values(value).every((colors) => isRecord(colors) && Object.values(colors).every(isHexColor));
const isColorList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isHexColor);
const isReviewerScope = (value: unknown): value is ReviewerScope => value === 'all' || value === 'required';
const isSortOrder = (value: unknown): value is SortOrder => value === 'provider' || value === 'oldest';

// O board de todos os projetos no formato do board de um projeto: os cards por coluna e os repositórios que aparecem
// neles (com o projeto de cada um, para guardar a cor no projeto certo).
function fromAllProjects(data: AllProjectsBoard): Board & { projectOf: Map<string, string> } {
  const columns: Board['columns'] = { dependsOnMe: [], review: [], conflict: [], ready: [] };
  const repositories = new Map<string, { id: string; name: string }>();
  const projectOf = new Map<string, string>();
  for (const { column, ...card } of data.items) {
    columns[column].push(card);
    repositories.set(card.repository.id, card.repository);
    projectOf.set(card.repository.id, card.project.id);
  }
  return {
    syncedAt: data.syncedAt,
    columns,
    repositories: [...repositories.values()].sort((a, b) => a.name.localeCompare(b.name)),
    projectOf,
  };
}

export function BoardPage() {
  const { me, project, allProjects, projects, projectsLoading, selectProject } = useSession();
  // Com "Todos os projetos" não há projeto: raias, cores e criação de release ficam desligadas.
  const projectId = allProjects ? undefined : project?.id;
  const boardKey = allProjects ? ALL_PROJECTS : projectId;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const now = useNow();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Vários repositórios podem ser filtrados juntos; lista vazia é "todos".
  const [chosenRepositories, setRepositoryFilter] = useState<string[]>([]);
  const [chosenTarget, setTargetFilter] = useState<string | null>(null);
  const [chosenAuthor, setAuthorFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [hidden, setHidden] = useStoredState<ColumnId[]>('rm.hiddenColumns', [], isColumnList);
  const [laneRepos, setLaneRepos] = useStoredState<Record<string, { merged?: string; release?: string }>>('rm.laneRepos', {}, isLaneChoice);
  const [reviewerScope, setReviewerScope] = useStoredState<ReviewerScope>('rm.reviewerScope', 'all', isReviewerScope);
  const [sortOrder, setSortOrder] = useStoredState<SortOrder>('rm.sortOrder', 'provider', isSortOrder);
  const [colorChoices, setColorChoices] = useStoredState<Record<string, Record<string, string>>>('rm.repoColors', {}, isColorChoice);
  const [customColors, setCustomColors] = useStoredState<string[]>('rm.customColors', [], isColorList);
  const [createState, setCreateState] = useState<CreateState>({ status: 'idle' });
  const [justCreated, setJustCreated] = useState(false);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Filtros de repositório e destino só fazem sentido dentro do projeto em que foram escolhidos.
  useEffect(() => {
    setRepositoryFilter([]);
    setTargetFilter(null);
    // "Você" vale em qualquer projeto; um colega escolhido pelo nome pode nem existir no outro.
    setAuthorFilter((current) => (current === AUTHOR_ME ? current : null));
    setCreateState({ status: 'idle' });
  }, [boardKey]);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);

  const singleBoard = useQuery({
    queryKey: ['board', projectId],
    queryFn: () => api.board(projectId!),
    enabled: !!projectId,
    refetchInterval: SYNC_INTERVAL_MS,
    retry: false,
  });
  const allBoard = useQuery({
    queryKey: ['board', ALL_PROJECTS],
    queryFn: api.allProjectsBoard,
    enabled: allProjects,
    refetchInterval: SYNC_INTERVAL_MS,
    retry: false,
  });
  const board = allProjects ? allBoard : singleBoard;
  const all = useMemo(() => (allBoard.data ? fromAllProjects(allBoard.data) : undefined), [allBoard.data]);
  const boardData: Board | undefined = allProjects ? all : singleBoard.data;

  // Com todos os projetos, cada repositório leva a cor guardada no próprio projeto.
  const colorProjectOf = (repositoryId: string) => (allProjects ? all?.projectOf.get(repositoryId) : projectId);
  const repositoryColors = useMemo<Record<string, string>>(
    () =>
      allProjects
        ? Object.assign({}, ...(allBoard.data?.projects ?? []).map((p) => colorChoices[p.id] ?? {}))
        : (projectId && colorChoices[projectId]) || {},
    [allProjects, allBoard.data, colorChoices, projectId],
  );
  const setRepositoryColor = (repositoryId: string, hex: string | null) => {
    const owner = colorProjectOf(repositoryId);
    if (!owner) return;
    const { [repositoryId]: _previous, ...others } = colorChoices[owner] ?? {};
    setColorChoices({ ...colorChoices, [owner]: hex ? { ...others, [repositoryId]: hex } : others });
  };

  const repositories = boardData?.repositories ?? [];
  const repositoryFilter = useMemo(
    () => chosenRepositories.filter((id) => repositories.some((repository) => repository.id === id)),
    [chosenRepositories, repositories],
  );
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

  // Cliques em sequência chegam antes de o botão ser redesenhado como desabilitado; só o primeiro vira pedido.
  const creating = useRef(false);
  // O projeto vai junto com o pedido: se o usuário trocar de projeto no meio, a resposta (e o "Tentar de novo")
  // continua valendo para o projeto em que a release foi pedida.
  const create = useMutation({
    mutationFn: (input: { projectId: string; repositoryId: string; name: string; pullRequestIds: number[] }) =>
      api.createRelease(input.projectId, input.repositoryId, input.name, input.pullRequestIds),
    onMutate: () => setCreateState({ status: 'creating' }),
    onSettled: () => {
      creating.current = false;
    },
    onSuccess: async (created, input) => {
      if (input.projectId === projectId) setLaneRepo('release', input.repositoryId);
      // A tela cheia da release guarda a própria cópia; sem isto ela mostraria a release anterior como a última.
      void queryClient.invalidateQueries({ queryKey: ['release', input.projectId] });
      void queryClient.invalidateQueries({ queryKey: ['lanes', input.projectId] });
      await queryClient.invalidateQueries({ queryKey: ['lane', input.projectId] });
      setCreateState({ status: 'idle' });
      setJustCreated(true);
      clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => setJustCreated(false), 9000);
      toast.show({
        kind: 'success',
        title: t('board.branchCreated', { name: created.name }),
        description: t('board.branchCreatedBody', { count: created.pullRequests, repository: created.repository }),
        action: {
          label: t('board.viewRelease'),
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
        title: t('board.createFailed'),
        description: conflict
          ? t('board.conflictBody', { id: conflictingId, base: String(error.details.baseBranch) })
          : error.message,
        // Token só de leitura: tentar de novo daria no mesmo.
        action: error instanceof ApiError && error.code === 'read-only' ? undefined : { label: t('common.retry'), onClick: () => create.mutate(input) },
      });
    },
  });

  const allOpen = useMemo(() => OPEN_COLUMNS.flatMap((id) => boardData?.columns[id] ?? []), [boardData]);
  const targets = useMemo(
    () => [...new Set(allOpen.map((pr) => pr.targetBranch))].sort().map((name) => ({ id: name, name })),
    [allOpen],
  );
  // "Você" primeiro, depois os colegas com PR aberto, em ordem alfabética.
  const authors = useMemo(() => {
    const others = new Map(allOpen.filter((pr) => !pr.author.isMe).map((pr) => [pr.author.name, pr.author]));
    return [
      { id: AUTHOR_ME, name: t('common.you'), person: { name: me.user.name, isMe: true, avatarKey: me.user.avatarKey } },
      ...[...others.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((author) => ({ id: author.name, name: author.name, person: author })),
    ];
  }, [allOpen, me.user.name, me.user.avatarKey]);
  // Um filtro só vale enquanto a opção existe: se o último PR daquele autor foi mergeado, o filtro deixa de agir
  // (e o botão já mostra "todos"), em vez de esvaziar o board sem explicação.
  const exists = (options: { id: string }[], value: string | null) => (options.some((option) => option.id === value) ? value : null);
  const targetFilter = exists(targets, chosenTarget);
  const authorFilter = exists(authors, chosenAuthor);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matches = (pr: PullRequestCard) =>
      (!authorFilter || (authorFilter === AUTHOR_ME ? pr.author.isMe : !pr.author.isMe && pr.author.name === authorFilter)) &&
      (repositoryFilter.length === 0 || repositoryFilter.includes(pr.repository.id)) &&
      (!targetFilter || pr.targetBranch === targetFilter) &&
      (!term ||
        pr.title.toLowerCase().includes(term) ||
        `#${pr.id}`.includes(term) ||
        pr.author.name.toLowerCase().includes(term) ||
        (pr.author.isMe && t('common.you').toLowerCase().includes(term)));
    const columns = boardData?.columns;
    const result = Object.fromEntries(
      OPEN_COLUMNS.map((id) => [id, sortCards((columns?.[id] ?? []).filter(matches), sortOrder)]),
    ) as Record<
      BoardColumnId,
      PullRequestCard[]
    >;
    // "Só obrigatório" esconde os PRs em que sou revisor opcional; os que aguardam o autor continuam.
    if (reviewerScope === 'required') {
      result.dependsOnMe = result.dependsOnMe.filter((pr) => pr.reason !== 'reviewer' || pr.requiredReviewer);
    }
    return result;
  }, [boardData, authorFilter, repositoryFilter, targetFilter, search, reviewerScope, sortOrder]);

  const myCards = (boardData?.columns.dependsOnMe ?? []).filter(
    (pr) => reviewerScope === 'all' || pr.reason !== 'reviewer' || pr.requiredReviewer,
  );
  const dependsOnMe = myCards.length;
  // PRs parados (na faixa vermelha) nas colunas de espera, como o resto do subtítulo: sem os filtros da toolbar.
  const stale = WAITING_COLUMNS.flatMap((id) => (id === 'dependsOnMe' ? myCards : (boardData?.columns[id] ?? []))).filter(
    (pr) => waitingBand(pr.waitingSince, now) === 'stale',
  ).length;
  const optionalHidden =
    reviewerScope === 'required' &&
    (boardData?.columns.dependsOnMe ?? []).some((pr) => pr.reason === 'reviewer' && !pr.requiredReviewer);
  const isFiltered =
    repositoryFilter.length > 0 || !!targetFilter || !!authorFilter || search.trim() !== '';

  // Sem projeto a consulta do board nem começa: não há o que esperar.
  const loading = !boardData && !board.isError && (projectsLoading || (!!boardKey && board.isPending));
  const syncing = board.isFetching || allLanes.isFetching || mergedLane.isFetching || releaseLane.isFetching;
  const mergedFailed = !mergedLane.data && (mergedLane.isError || (allLanes.isError && !mergedLane.isFetching));
  const releaseFailed = !releaseLane.data && (releaseLane.isError || (allLanes.isError && !releaseLane.isFetching));
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] });
    void board.refetch();
    if (allProjects) return;
    // O lote semeia as raias de cada repositório; as que falharam nele são buscadas de novo uma a uma.
    void allLanes.refetch().then(() => {
      if (mergedLane.isError) void mergedLane.refetch();
      if (releaseLane.isError) void releaseLane.refetch();
    });
  };

  const counts: Partial<Record<ColumnId, number>> = boardData
    ? {
        ...Object.fromEntries(OPEN_COLUMNS.map((id) => [id, filtered[id].length])),
        merged: mergedLane.data?.merged.length,
        release: releaseLane.data?.release?.pullRequests.length,
      }
    : {};
  const show = (id: ColumnId) => !hidden.includes(id);
  const boardRef = useRef<HTMLElement>(null);
  // Mergeados e Release dependem de um repositório: com todos os projetos, um aviso fica no lugar delas.
  const boardColumns = allProjects ? COLUMNS.filter((column) => OPEN_COLUMNS.some((id) => id === column.id)) : COLUMNS;
  useColumnSlots(boardRef, boardColumns.filter((column) => show(column.id)).map((column) => column.id).join());
  const chooseProject = () => setSwitcherOpen(true);
  const failedProjects = allProjects ? (allBoard.data?.failed ?? []) : [];
  const skippedProjects = allProjects ? (allBoard.data?.skipped ?? 0) : 0;

  const renderColumn = (column: (typeof COLUMNS)[number]) => {
    if (column.id === 'merged') {
      return (
        <MergedColumn
          // Seleção e nome de branch são do repositório: trocar de repositório recomeça os dois. No GitHub o
          // número do PR se repete entre repositórios, e um PR marcado num não pode chegar marcado no outro.
          key={mergedRepo}
          repositories={repositories}
          repositoryId={mergedRepo}
          onRepositoryChange={(id) => {
            setLaneRepo('merged', id);
            setCreateState({ status: 'idle' });
          }}
          lane={mergedLane.data}
          loading={loading || (!mergedLane.data && !!mergedRepo && (allLanes.isPending || mergedLane.isFetching))}
          failed={mergedFailed}
          state={createState}
          onSelectionChange={() => createState.status === 'failed' && setCreateState({ status: 'idle' })}
          readOnly={!me.capabilities.createRelease}
          onCreate={(name, pullRequestIds) => {
            if (!projectId || !mergedRepo || creating.current) return;
            creating.current = true;
            create.mutate({ projectId, repositoryId: mergedRepo, name, pullRequestIds });
          }}
        />
      );
    }
    if (column.id === 'release') {
      return (
        <ReleaseColumn
          repositories={repositories}
          repositoryId={releaseRepo}
          onRepositoryChange={(id) => setLaneRepo('release', id)}
          lane={releaseLane.data}
          loading={loading || (!releaseLane.data && !!releaseRepo && (allLanes.isPending || releaseLane.isFetching))}
          failed={releaseFailed}
          highlight={justCreated}
          now={now}
        />
      );
    }
    return (
      <OpenColumn
        id={column.id}
        cards={filtered[column.id]}
        repositoryColors={repositoryColors}
        loading={loading}
        emptyState={!!boardData && !isFiltered && !(column.id === 'dependsOnMe' && optionalHidden)}
        filtered={isFiltered || (column.id === 'dependsOnMe' && optionalHidden)}
        emptyNote={
          column.id === 'dependsOnMe' && optionalHidden && !isFiltered
            ? t('board.noneRequired')
            : undefined
        }
        controls={
          column.id === 'dependsOnMe' && !loading ? (
            <ReviewerScopeToggle value={reviewerScope} onChange={setReviewerScope} />
          ) : undefined
        }
        headerAction={column.id === 'dependsOnMe' ? <WaitingMax cards={filtered.dependsOnMe} now={now} /> : undefined}
        now={now}
      />
    );
  };

  return (
    <div data-page="board" className="flex h-full min-h-[35rem] flex-col">
      <TopBar />

      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 px-8 pb-5 pt-7">
        <div className="flex flex-col gap-2.5">
          <ProjectSwitcher
            projects={projects}
            current={project}
            loading={projectsLoading}
            onSelect={selectProject}
            allProjects={allProjects}
            open={switcherOpen}
            onOpenChange={setSwitcherOpen}
            organization={me.accounts.filter((account) => account.connected && account.provider !== 'jira').length > 1 ? me.organization : undefined}
          />
          <h1 className="text-2xl font-bold tracking-[-0.3px] text-ink">{t('board.title')}</h1>
          <div className="flex h-4 items-center gap-2 text-[0.8125rem]">
            {loading || !boardData ? null : (
              <>
                <span className="font-medium text-ink-2">
                  {t('board.openPrs', { count: allOpen.length })}
                </span>
                <span className="text-[#CBD5E1]">·</span>
                {dependsOnMe > 0 ? (
                  <span className="font-semibold text-[#B45309]">
                    {t('board.waitingOnYou', { count: dependsOnMe })}
                  </span>
                ) : (
                  <span className="font-semibold text-[#16A34A]">{t('board.nothingOnYou')}</span>
                )}
                {stale > 0 && (
                  <>
                    <span className="text-[#CBD5E1]">·</span>
                    <span className="font-semibold text-[#DC2626]">{t('waiting.stale', { count: stale, days: STALE_DAYS })}</span>
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2.5">
          <FilterSelect
            icon={AuthorIcon}
            label={t('board.author')}
            allLabel={t('board.allAuthors')}
            options={authors}
            value={authorFilter}
            onChange={setAuthorFilter}
            plain
          />
          <RepositoryFilter
            label={t('board.repository')}
            allLabel={t('board.allRepositories')}
            countLabel={(count) => t('board.repositoriesSelected', { count })}
            repositories={repositories}
            value={repositoryFilter}
            onChange={setRepositoryFilter}
            colors={repositoryColors}
            onColorChange={setRepositoryColor}
            customColors={customColors}
            onCustomColorsChange={setCustomColors}
          />
          <FilterSelect
            icon={TargetIcon}
            label={t('board.target')}
            allLabel={t('board.allTargets')}
            options={targets}
            value={targetFilter}
            onChange={setTargetFilter}
          />
          <FilterSelect
            icon={ArrowDownWideNarrow}
            label={t('waiting.sort')}
            allLabel={t('waiting.sortProvider')}
            options={[{ id: 'oldest', name: t('waiting.sortOldest') }]}
            value={sortOrder === 'oldest' ? 'oldest' : null}
            onChange={(value) => setSortOrder(value === 'oldest' ? 'oldest' : 'provider')}
            plain
          />
          <ColumnsDropdown hidden={hidden} counts={counts} onChange={setHidden} columns={boardColumns} />
          <SearchBox value={search} onChange={setSearch} />
          <SyncControls
            syncing={syncing}
            failed={board.isError || mergedFailed || releaseFailed}
            lastSync={boardData && elapsedLabel(boardData.syncedAt, now)}
            onRefresh={refresh}
          />
        </div>
      </div>

      {(failedProjects.length > 0 || skippedProjects > 0) && (
        <div className="flex flex-col gap-2 px-8 pb-4">
          {failedProjects.map(({ project: failed, reason }) => (
            <Notice
              key={failed.id}
              text={t('board.projectFailed', { project: failed.name, reason })}
              action={t('board.tryAgain')}
              onAction={() => void allBoard.refetch()}
              busy={allBoard.isFetching}
            />
          ))}
          {skippedProjects > 0 && (
            <Notice
              text={t('board.tooManyProjects', { count: skippedProjects, limit: allBoard.data?.projects.length ?? 0 })}
              action={t('board.chooseProject')}
              onAction={chooseProject}
            />
          )}
        </div>
      )}

      {/* O board não rola na vertical: cada coluna cuida do próprio conteúdo. */}
      {/* O respiro de 2px no topo deixa inteiro o contorno de 2px das colunas destacadas (o board corta o que passa da borda). */}
      <main ref={boardRef} className="column-scroll flex min-h-0 flex-1 items-start gap-4 overflow-x-auto overflow-y-hidden px-8 pb-8 pt-0.5">
        {/* Colunas ocultas continuam montadas: assim esconder e revelar podem animar. */}
        {boardColumns.map((column) => (
          <ColumnSlot key={column.id} shown={show(column.id)}>
            {renderColumn(column)}
          </ColumnSlot>
        ))}
        {allProjects && <PerRepositoryPlaceholder onChooseProject={chooseProject} />}
      </main>
    </div>
  );
}

// Aviso acima do board, com uma ação: tentar de novo ou escolher um projeto.
function Notice({ text, action, onAction, busy }: { text: string; action: string; onAction: () => void; busy?: boolean }) {
  return (
    <div role="status" className="stroke flex items-center gap-2.5 rounded-[0.625rem] bg-[#FFFBEB] px-3.5 py-2.5 [--stroke:#FDE68A]">
      <TriangleAlert size={rem(15)} className="shrink-0 text-[#B45309]" />
      <p className="min-w-0 flex-1 text-[0.8125rem] text-[#92400E]">{text}</p>
      <button
        type="button"
        onClick={onAction}
        disabled={busy}
        className="shrink-0 rounded-md px-2 py-1 text-[0.8125rem] font-semibold text-[#92400E] hover:bg-[#FEF3C7] disabled:opacity-60"
      >
        {action}
      </button>
    </div>
  );
}
