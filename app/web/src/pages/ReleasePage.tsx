import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bug,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  FileText,
  GitBranch,
  GitMerge,
  Link as LinkIcon,
  LoaderCircle,
  Minimize2,
  RefreshCw,
  Search,
  SquareCheckBig,
  TriangleAlert,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ReleaseNotesDialog } from '../components/releaseNotes';
import { useToast } from '../components/toast';
import { TopBar } from '../components/TopBar';
import { Avatar, cx, RepoSelect } from '../components/ui';
import {
  api,
  type LanePullRequest,
  type ReleaseDetails,
  type WorkItem,
  type WorkItemStateCategory,
  type WorkItemSummary,
} from '../lib/api';
import { authorLabel, elapsedLabel, releaseMeta, shortDate, useNow } from '../lib/format';
import { LANE_STALE_MS, releaseKey, SYNC_INTERVAL_MS, useAllLanes } from '../lib/lanes';
import { useSession } from '../lib/session';
import { t } from '../lib/i18n';
import { rem } from '../lib/units';

const PILL: Record<WorkItemStateCategory, string> = {
  done: 'bg-[#DCFCE7] text-[#166534]',
  testing: 'bg-[#E0F2FE] text-[#075985]',
  'in-progress': 'bg-[#DBEAFE] text-[#1E40AF]',
  todo: 'bg-[#F1F5F9] text-[#334155]',
  removed: 'bg-[#F1F5F9] text-[#64748B]',
};

function StatusPill({ state }: { state: WorkItemSummary['state'] }) {
  return (
    <span className={cx('whitespace-nowrap rounded-[0.625rem] px-2 py-0.5 text-xs font-medium', PILL[state.category])}>
      {state.name}
    </span>
  );
}

function WorkItemIcon({ kind, size = 14 }: { kind: WorkItemSummary['kind']; size?: number }) {
  if (kind === 'bug') return <Bug size={rem(size)} className="shrink-0 text-[#DC2626]" />;
  if (kind === 'pbi') return <ClipboardList size={rem(size)} className="shrink-0 text-[#2563EB]" />;
  return <SquareCheckBig size={rem(size)} className="shrink-0 text-[#CA8A04]" />;
}

function PullRequestCells({ pr }: { pr: LanePullRequest }) {
  return (
    <>
      <div className="flex min-w-0 flex-1 basis-0 items-center gap-2">
        <GitMerge size={rem(14)} className="shrink-0 text-[#8B5CF6]" />
        <a href={pr.webUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-mute hover:underline">
          #{pr.id}
        </a>
        <span className="truncate text-[0.8125rem] text-ink" title={pr.title}>{pr.title}</span>
      </div>
      <div className="flex w-[10.625rem] shrink-0 items-center gap-2">
        <Avatar name={pr.author.name} isMe={pr.author.isMe} avatarKey={pr.author.avatarKey} />
        <span className="truncate text-[0.8125rem] text-ink-2">{authorLabel(pr.author)}</span>
      </div>
      <div className="w-20 shrink-0 whitespace-nowrap text-[0.8125rem] text-mute">{shortDate(pr.mergedAt)}</div>
    </>
  );
}

// Espaço fixo do popover fora da lista (campo de busca, rótulo e respiros) e altura máxima da lista, em px do design.
const POPOVER_CHROME = 96;
const RESULTS_MAX = 280;

// Conteúdo do popover de vincular task. Posição, lado (acima ou abaixo do botão, o que tiver mais espaço), foco e
// fechamento são do Radix; a lista encolhe até a altura disponível, para o popover não passar da borda da janela.
function LinkTaskPopover({
  projectId,
  initialTerm,
  linking,
  onPick,
}: {
  projectId: string;
  initialTerm: string;
  linking: boolean;
  onPick: (item: WorkItem) => void;
}) {
  const { tracker } = useSession().me;
  const jira = tracker?.provider === 'jira';
  const [term, setTerm] = useState(initialTerm);
  const [debounced, setDebounced] = useState(initialTerm);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(timer);
  }, [term]);

  const results = useQuery({
    queryKey: ['work-items', projectId, debounced],
    queryFn: () => api.searchWorkItems(projectId, debounced),
    enabled: debounced.length >= 2 || /^\d+$/.test(debounced),
    staleTime: 30_000,
  });
  const items = results.data ?? [];
  useEffect(() => setActive(0), [debounced]);
  // Enquanto a busca do que foi digitado não volta, a lista ainda é a da busca anterior.
  const searching = results.isFetching || term.trim() !== debounced;
  const listId = useId();
  const optionId = (index: number) => `${listId}-${index}`;
  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, items.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // Enter antes de a busca voltar vincularia o primeiro item da lista antiga, não o que foi digitado.
      if (items[active] && !linking && !searching) onPick(items[active]);
    }
  };

  return (
    <Popover.Content
      aria-label={t('release.linkTask')}
      align="start"
      sideOffset={8}
      collisionPadding={16}
      className={cx(
        'stroke z-50 flex w-[26.25rem] max-w-[calc(100vw-3rem)] flex-col gap-0.5 rounded-xl bg-white p-1.5 shadow-[0_0.75rem_2rem_#0F172A26] outline-none data-[side=bottom]:pop-in data-[side=top]:pop-in-up',
      )}
    >
      <label className="stroke-focus flex items-center gap-2 rounded-lg bg-soft px-3 py-2.5">
        <Search size={rem(14)} className="shrink-0 text-[#6366F1]" />
        <input
          ref={inputRef}
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={jira ? t('release.searchJira') : t('release.searchTask')}
          aria-label={t('release.searchAria')}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items[active] ? optionId(active) : undefined}
          className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink caret-[#6366F1] outline-none placeholder:text-faint"
        />
        {searching && <LoaderCircle size={rem(14)} className="shrink-0 animate-spin text-faint" />}
      </label>
      <div className="px-3 pb-1 pt-2.5 text-[0.6875rem] font-semibold tracking-[0.5px] text-faint">
        {term.trim() === initialTerm && initialTerm ? t('release.suggestions') : t('release.results')}
      </div>
      <div
        id={listId}
        role="listbox"
        aria-busy={searching}
        className={cx('flex flex-col gap-0.5 overflow-y-auto transition-opacity', searching && items.length > 0 && 'opacity-50')}
        style={{
          maxHeight: `max(3.5rem, min(${rem(RESULTS_MAX)}, calc(var(--radix-popover-content-available-height) - ${rem(POPOVER_CHROME)})))`,
        }}
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            id={optionId(index)}
            type="button"
            role="option"
            aria-selected={index === active}
            disabled={linking || searching}
            onMouseEnter={() => setActive(index)}
            onClick={() => onPick(item)}
            className={cx('flex gap-2.5 rounded-lg px-3 py-2.5 text-left', index === active && 'bg-[#EEF2FF]')}
          >
            <WorkItemIcon kind={item.kind} size={15} />
            <span className="flex min-w-0 flex-1 flex-col gap-[0.1875rem]">
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs text-mute">{item.key ?? item.id}</span>
                <span className="truncate text-[0.8125rem] font-medium text-ink">{item.title}</span>
              </span>
              <span className="truncate text-xs text-faint">
                {item.parent
                  ? `${item.parent.key ?? `PBI ${item.parent.id}`} · ${item.parent.title}`
                  : jira
                    ? t('release.noParentEpic')
                    : t('release.noParentPbi')}
              </span>
            </span>
            {index === active && <span className="text-[0.8125rem] font-semibold text-[#6366F1]">↵</span>}
          </button>
        ))}
        {items.length === 0 && (
          <p className="px-3 py-2.5 text-xs text-faint">
            {results.isError
              ? t('release.searchFailed', { tracker: tracker?.name ?? 'Jira' })
              : searching
                ? t('release.searching')
                : debounced.length < 2
                  ? jira
                    ? t('release.typeMoreJira')
                    : t('release.typeMore')
                  : t('release.noneFound')}
          </p>
        )}
      </div>
    </Popover.Content>
  );
}

function UnlinkedRow({
  pr,
  projectId,
  linking,
  onLink,
}: {
  pr: ReleaseDetails['unlinked'][number];
  projectId: string;
  linking: boolean;
  onLink: (pr: LanePullRequest, item: WorkItem, done: () => void) => void;
}) {
  const [open, setOpen] = useState(false);
  const { tracker } = useSession().me;
  return (
    <div className="flex items-center gap-4 px-5 py-3">
      <div className="flex min-w-0 flex-1 basis-0">
        {/* Com o GitHub sem Jira não há de onde buscar tasks. */}
        {!tracker && <span className="ml-7 text-[0.8125rem] text-faint">{t('release.connectJira')}</span>}
        {tracker && (
          <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger className="stroke ml-7 flex items-center gap-1.5 rounded-md bg-white px-2.5 py-[0.3125rem] [--stroke:#FCD34D] hover:bg-[#FEF3C7] hover:[--stroke:#F59E0B] data-[state=open]:bg-[#FEF3C7] data-[state=open]:[--stroke:#F59E0B]">
              <LinkIcon size={rem(13)} className="text-[#B45309]" />
              <span className="text-[0.78125rem] font-semibold text-[#92400E]">{t('release.linkTask')}</span>
            </Popover.Trigger>
            <Popover.Portal>
              <LinkTaskPopover
                projectId={projectId}
                initialTerm={pr.suggestedTerm}
                linking={linking}
                onPick={(item) => onLink(pr, item, () => setOpen(false))}
              />
            </Popover.Portal>
          </Popover.Root>
        )}
      </div>
      <div className="w-[8.75rem] shrink-0 text-[0.8125rem] text-[#CBD5E1]">—</div>
      <PullRequestCells pr={pr} />
    </div>
  );
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'warn' | 'ok' }) {
  const color = tone === 'warn' ? 'text-[#B45309]' : tone === 'ok' ? 'text-[#16A34A]' : undefined;
  return (
    <div className="flex items-end gap-2">
      <span className={cx('text-[1.375rem] font-bold', color ?? 'text-ink')}>{value}</span>
      <span className={cx('text-[0.8125rem]', color ? `${color} font-semibold` : 'text-mute')}>{label}</span>
    </div>
  );
}

export function ReleasePage() {
  const { project, me } = useSession();
  const jira = me.tracker?.provider === 'jira';
  const projectId = project?.id;
  const [params, setParams] = useSearchParams();
  const now = useNow();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [collapsed, setCollapsed] = useState<number[]>([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const [freshLink, setFreshLink] = useState<{ pullRequestId: number; workItemId: number } | null>(null);

  const board = useQuery({
    queryKey: ['board', projectId],
    queryFn: () => api.board(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
    retry: false,
  });
  const repositories = board.data?.repositories ?? [];
  const requested = params.get('repo');
  const repositoryId = repositories.some((r) => r.id === requested) ? requested! : repositories[0]?.id;
  const branch = repositoryId === requested ? (params.get('branch') ?? undefined) : undefined;

  const details = useQuery({
    queryKey: releaseKey(projectId, repositoryId, branch),
    queryFn: () => api.release(projectId!, repositoryId!, branch),
    enabled: !!projectId && !!repositoryId,
    staleTime: LANE_STALE_MS,
    gcTime: 3 * LANE_STALE_MS,
    refetchInterval: SYNC_INTERVAL_MS,
    retry: false,
  });

  // Em segundo plano, deixa pronta a release dos outros repositórios, para a troca no seletor ser imediata.
  const allLanes = useAllLanes(projectId);
  const withRelease = (allLanes.data?.lanes ?? []).filter((lane) => lane.release).map((lane) => lane.repository.id);
  const prefetchKey = withRelease.join(',');
  useEffect(() => {
    if (!projectId || !details.isFetched) return;
    let cancelled = false;
    const queue = withRelease.filter((id) => id !== repositoryId);
    const worker = async () => {
      for (let id = queue.shift(); id && !cancelled; id = queue.shift()) {
        const target = id;
        await queryClient.prefetchQuery({
          queryKey: releaseKey(projectId, target),
          queryFn: () => api.release(projectId, target),
          staleTime: LANE_STALE_MS,
          gcTime: 3 * LANE_STALE_MS,
          retry: false,
        });
      }
    };
    void Promise.all([worker(), worker()]);
    return () => {
      cancelled = true;
    };
    // A fila depende só de quais repositórios têm release; reiniciar a cada troca de repositório refaria o trabalho.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, prefetchKey, details.isFetched]);
  const data = details.data;
  // Cada vínculo carrega o repositório em que foi feito: se o usuário trocar de repositório antes de a resposta
  // chegar (ou antes de clicar em "Desfazer"), a operação continua valendo para o repositório certo.
  type Target = { projectId: string; repositoryId: string };
  const invalidate = (target: Target) =>
    queryClient.invalidateQueries({ queryKey: ['release', target.projectId, target.repositoryId] });

  const unlink = useMutation({
    mutationFn: (input: Target & { pullRequestId: number; workItemId: number }) =>
      api.unlinkWorkItem(input.projectId, input.repositoryId, input.pullRequestId, input.workItemId),
    onSuccess: async (_result, target) => {
      setFreshLink(null);
      await invalidate(target);
    },
    onError: (error) => toast.show({ kind: 'error', title: t('release.unlinkFailed'), description: error.message }),
  });

  const link = useMutation({
    mutationFn: (input: Target & { pr: LanePullRequest; item: WorkItem; done: () => void }) =>
      api.linkWorkItem(input.projectId, input.repositoryId, input.pr.id, input.item.id),
    onSuccess: async (_result, { pr, item, done, ...target }) => {
      await invalidate(target);
      done();
      setFreshLink({ pullRequestId: pr.id, workItemId: item.id });
      toast.show({
        kind: 'success',
        title: t('release.linked', { key: item.key ?? item.id, id: pr.id }),
        description: me.tracker ? t('release.savedIn', { tracker: me.tracker.name }) : undefined,
        action: { label: t('common.undo'), onClick: () => unlink.mutate({ ...target, pullRequestId: pr.id, workItemId: item.id }) },
      });
    },
    onError: (error) => toast.show({ kind: 'error', title: t('release.linkFailed'), description: error.message }),
    onSettled: () => {
      linking.current = false;
    },
  });
  // Dois cliques (ou Enter repetido) chegam antes de a lista ser desabilitada; só o primeiro vira pedido.
  const linking = useRef(false);

  const release = data?.release;
  const failed = !data && (details.isError || board.isError);
  // Sem projeto ou sem repositório as consultas nem começam: não há o que esperar.
  const loading = !data && !failed && !!projectId && (board.isPending || !!repositoryId);
  const navigate = useNavigate();

  return (
    <div data-page="release" className="flex h-full min-h-[35rem] flex-col">
      <TopBar />

      {/* A coluna Release aberta em tela cheia, com o mesmo contorno roxo dela. */}
      <div className="stroke-2 m-4 flex min-h-0 flex-1 flex-col rounded-xl bg-canvas [--stroke:#DDD6FE]">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 px-8 pb-5 pt-6">
        <div className="flex min-w-0 flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            <GitBranch size={rem(22)} className="shrink-0 text-[#7C3AED]" />
            <h1 className="truncate font-mono text-2xl font-bold tracking-[-0.3px] text-ink" title={release?.name}>
              {release?.name ?? (loading ? t('common.loading') : failed ? t('release.loadFailed') : t('release.none'))}
            </h1>
            {release?.isLatest && (
              <span className="rounded bg-[#EDE9FE] px-2 py-[0.1875rem] text-xs font-semibold text-[#6D28D9]">{t('common.latest')}</span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[0.8125rem] text-mute">
              {(release && releaseMeta(release, now)) || ' '}
            </span>
            <button
              type="button"
              onClick={() => {
                if (board.isError) void board.refetch();
                void details.refetch();
              }}
              disabled={details.isFetching}
              className="stroke flex items-center gap-1.5 rounded-md bg-white px-2.5 py-[0.3125rem] hover-surface"
            >
              <RefreshCw size={rem(13)} className={cx('text-ink-2', details.isFetching && 'animate-spin')} />
              <span className="text-[0.78125rem] font-semibold text-ink">{details.isFetching ? t('common.syncing') : t('common.refresh')}</span>
            </button>
            <span
              className={cx('text-xs', details.isError || board.isError ? 'text-[#DC2626]' : 'text-faint')}
              title={(details.isError || board.isError) && data ? t('common.lastSync', { when: elapsedLabel(data.syncedAt, now) }) : undefined}
            >
              {details.isError || board.isError
                ? t('common.syncFailed')
                : data
                  ? t('common.synced', { when: elapsedLabel(data.syncedAt, now) })
                  : ''}
            </span>
          </div>
        </div>

        <div className="flex flex-col items-end justify-between gap-7 self-stretch">
          <button
            type="button"
            onClick={() => void navigate('/', { viewTransition: true })}
            className="stroke flex items-center gap-1.5 rounded-lg bg-white px-3.5 py-2 hover-surface"
          >
            <Minimize2 size={rem(14)} className="text-ink-2" />
            <span className="text-[0.8125rem] font-medium text-ink">{t('release.back')}</span>
          </button>
          <div className="flex items-center gap-2.5">
            <RepoSelect
              tone="violet"
              className="w-[13.75rem]"
              repositories={repositories}
              value={repositoryId}
              onChange={(id) => setParams({ repo: id })}
            />
            <button
              type="button"
              onClick={() => setNotesOpen(true)}
              disabled={!data || !release}
              className="stroke flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-white px-3.5 py-2 hover-surface disabled:pointer-events-none disabled:bg-[#F1F5F9]"
            >
              <FileText size={rem(14)} className={release ? 'text-ink-2' : 'text-faint'} />
              <span className={cx('text-[0.8125rem] font-semibold', release ? 'text-ink' : 'text-faint')}>{t('notes.open')}</span>
            </button>
            <a
              href={release?.webUrl}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!release}
              className={cx(
                'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 py-2',
                release ? 'hover-primary bg-ink' : 'pointer-events-none bg-[#E2E8F0]',
              )}
            >
              <ExternalLink size={rem(14)} className={release ? 'text-white' : 'text-faint'} />
              <span className={cx('text-[0.8125rem] font-semibold', release ? 'text-white' : 'text-faint')}>
                {t('release.openIn', { source: me.source?.name ?? 'Azure DevOps' })}
              </span>
            </a>
          </div>
        </div>
      </div>

      {data && release && (
        <div className="flex flex-wrap gap-x-10 gap-y-2 px-8 pb-5">
          <Stat value={data.summary.pullRequests} label={t('release.statPrs', { count: data.summary.pullRequests })} />
          <Stat value={data.summary.tasks} label={t('release.statTasks', { count: data.summary.tasks })} />
          <Stat value={data.summary.pbis} label={t(jira ? 'release.statEpics' : 'release.statPbis', { count: data.summary.pbis })} />
          <Stat
            value={data.summary.unlinked}
            label={t('release.statUnlinked', { count: data.summary.unlinked })}
            tone={data.summary.unlinked > 0 ? 'warn' : 'ok'}
          />
        </div>
      )}

      {/* Só a tabela rola: o cabeçalho da release fica parado e o das colunas gruda no topo da lista. */}
      <main className="flex min-h-0 flex-1 flex-col px-8 pb-8">
        <div className="stroke column-scroll flex min-h-0 flex-col overflow-y-auto rounded-[0.625rem] bg-white">
          <div className="sticky top-0 z-10 flex shrink-0 gap-4 rounded-t-[0.625rem] border-b border-line bg-soft px-5 py-2.5 text-[0.6875rem] font-semibold tracking-[0.5px] text-mute">
            <div className="flex-1 basis-0">{t('release.headWorkItem')}</div>
            <div className="w-[8.75rem] shrink-0">{t('release.headState')}</div>
            <div className="flex-1 basis-0">{t('release.headPullRequest')}</div>
            <div className="w-[10.625rem] shrink-0">{t('release.headAuthor')}</div>
            <div className="w-20 shrink-0">{t('release.headMerge')}</div>
          </div>

          {loading &&
            Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex gap-4 border-b border-line-soft px-5 py-3.5 last:border-b-0" aria-hidden>
                <div className="skeleton h-3.5 flex-1 rounded-[0.4375rem]" />
                <div className="skeleton h-3.5 w-[8.75rem] rounded-[0.4375rem]" />
                <div className="skeleton h-3.5 flex-1 rounded-[0.4375rem]" />
                <div className="skeleton h-3.5 w-[15.625rem] rounded-[0.4375rem]" />
              </div>
            ))}

          {failed && (
            <p className="px-5 py-6 text-[0.8125rem] text-[#DC2626]">
              {(details.error ?? board.error)?.message ?? t('common.syncFailed')}
            </p>
          )}
          {data && !release && (
            <p className="px-5 py-6 text-[0.8125rem] text-mute">{t('lanes.noReleaseBranch')}</p>
          )}
          {data && release && data.summary.pullRequests === 0 && (
            <p className="px-5 py-6 text-[0.8125rem] text-mute">{t('lanes.noPrsInRelease')}</p>
          )}

          {data?.groups.map((group) => {
            const isCollapsed = collapsed.includes(group.pbi.id);
            return (
              <div key={group.pbi.id}>
                <button
                  type="button"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed(isCollapsed ? collapsed.filter((id) => id !== group.pbi.id) : [...collapsed, group.pbi.id])
                  }
                  className="flex w-full items-center gap-2.5 border-b border-line-row bg-[#FBFBFD] px-5 py-[0.6875rem] text-left"
                >
                  <ChevronDown size={rem(14)} className={cx('shrink-0 text-faint transition-transform', isCollapsed && '-rotate-90')} />
                  <WorkItemIcon kind="pbi" size={15} />
                  <span className="whitespace-nowrap font-mono text-xs text-mute">{group.pbi.key ?? `PBI ${group.pbi.id}`}</span>
                  <span className="truncate text-[0.8125rem] font-semibold text-ink" title={group.pbi.title}>{group.pbi.title}</span>
                  <StatusPill state={group.pbi.state} />
                  <span className="ml-auto whitespace-nowrap pl-2 text-xs text-mute">
                    {t('release.tasks', { count: group.tasks })} · {t('common.prCount', { count: group.pullRequests })}
                  </span>
                </button>
                {!isCollapsed &&
                  group.rows.map((row) => {
                    const fresh =
                      freshLink?.pullRequestId === row.pullRequest.id && freshLink.workItemId === row.task?.id;
                    return (
                      <div
                        key={`${row.task?.id ?? 'pbi'}-${row.pullRequest.id}`}
                        className={cx('flex items-center gap-4 border-b border-line-soft px-5 py-3', fresh && 'bg-[#F0FDF4]')}
                      >
                        <div className="min-w-0 flex-1 basis-0">
                          <div className="flex min-w-0 items-center gap-2 pl-7">
                          {row.task ? (
                            <>
                              <WorkItemIcon kind={row.task.kind} />
                              <a
                                href={row.task.webUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="font-mono text-xs text-mute hover:underline"
                              >
                                {row.task.key ?? row.task.id}
                              </a>
                              <span className="truncate text-[0.8125rem] font-medium text-ink" title={row.task.title}>{row.task.title}</span>
                            </>
                          ) : (
                            <span className="text-[0.8125rem] text-faint">{jira ? t('release.linkedDirectly') : t('release.linkedToPbi')}</span>
                          )}
                          </div>
                        </div>
                        <div className="flex w-[8.75rem] shrink-0 items-center">
                          {row.task ? <StatusPill state={row.task.state} /> : <span className="text-[0.8125rem] text-[#CBD5E1]">—</span>}
                        </div>
                        <PullRequestCells pr={row.pullRequest} />
                      </div>
                    );
                  })}
              </div>
            );
          })}

          {data && data.unlinked.length > 0 && (
            <>
              <div className="flex items-center gap-2.5 border-y border-[#FDE68A] bg-[#FFFBEB] px-5 py-[0.6875rem] [&:not(:first-child)]:-mt-px">
                <TriangleAlert size={rem(15)} className="shrink-0 text-[#B45309]" />
                <span className="text-[0.8125rem] font-semibold text-[#92400E]">{t('release.unlinkedTitle')}</span>
                <span className="truncate text-xs text-[#B45309]">{t('release.unlinkedDescription')}</span>
              </div>
              {data.unlinked.map((pr) => (
                <UnlinkedRow
                  key={pr.id}
                  pr={pr}
                  projectId={projectId!}
                  linking={link.isPending}
                  onLink={(target, item, done) => {
                    if (!repositoryId || linking.current) return;
                    linking.current = true;
                    link.mutate({ projectId: projectId!, repositoryId, pr: target, item, done });
                  }}
                />
              ))}
            </>
          )}
        </div>
      </main>
      </div>
      {data && release && <ReleaseNotesDialog details={data} jira={jira} open={notesOpen} onOpenChange={setNotesOpen} />}
    </div>
  );
}
