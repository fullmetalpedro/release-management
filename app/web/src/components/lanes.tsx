import { GitBranch, GitBranchPlus, GitMerge, LoaderCircle, Maximize2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LanePullRequest, ReleaseLane } from '../lib/api';
import { authorLabel, releaseMeta, shortDate } from '../lib/format';
import { ColumnShell, QuietNote } from './board';
import { Checkbox, cx, RepoSelect, SkeletonCard } from './ui';
import { t } from '../lib/i18n';
import { rem } from '../lib/units';

interface Repo {
  id: string;
  name: string;
}

function PrMeta({ pr }: { pr: LanePullRequest }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[0.71875rem] text-faint">#{pr.id}</span>
      <span className="text-xs text-[#CBD5E1]">·</span>
      <span className="truncate text-xs text-mute">{authorLabel(pr.author)}</span>
      <span className="text-xs text-[#CBD5E1]">·</span>
      <span className="shrink-0 whitespace-nowrap text-xs text-mute">{shortDate(pr.mergedAt)}</span>
    </div>
  );
}

const BRANCH_PATTERN = /^(?!\/)(?!.*(\.\.|\/\/|@\{))[^\s~^:?*[\\]+(?<![/.])$/;

export type CreateState =
  | { status: 'idle' }
  | { status: 'creating' }
  | { status: 'failed'; conflictingId?: number };

export function MergedColumn({
  repositories,
  repositoryId,
  onRepositoryChange,
  lane,
  loading,
  failed,
  state,
  onCreate,
  onSelectionChange,
}: {
  repositories: Repo[];
  repositoryId: string | undefined;
  onRepositoryChange: (id: string) => void;
  lane: ReleaseLane | undefined;
  loading: boolean;
  // A raia deste repositório não carregou: não dá para afirmar que não há PRs.
  failed: boolean;
  state: CreateState;
  onCreate: (name: string, pullRequestIds: number[]) => void;
  onSelectionChange: () => void;
}) {
  const [selected, setSelected] = useState<number[]>([]);
  const [branch, setBranch] = useState('');
  const creating = state.status === 'creating';
  const merged = lane?.merged ?? [];

  // A sugestão muda quando o repositório muda ou uma release nasce; a seleção antiga deixa de valer.
  const suggested = lane?.suggestedBranch ?? '';
  useEffect(() => setBranch(suggested), [suggested]);
  const mergedKey = merged.map((pr) => pr.id).join(',');
  useEffect(() => {
    setSelected((current) => current.filter((id) => merged.some((pr) => pr.id === id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedKey]);

  const update = (next: number[]) => {
    setSelected(next);
    onSelectionChange();
  };
  const toggle = (id: number) => update(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  const allSelected = merged.length > 0 && selected.length === merged.length;
  const canCreate = selected.length > 0 && BRANCH_PATTERN.test(branch.trim()) && !creating;

  if (loading) {
    return (
      <ColumnShell id="merged">
        <SkeletonCard />
        <SkeletonCard />
      </ColumnShell>
    );
  }

  const createPanel = (
    <div className="stroke flex flex-col gap-2.5 rounded-lg bg-white p-3.5 [--stroke:#99F6E4]">
      <div className="flex items-center justify-between">
        <span className={cx('text-[0.8125rem] font-semibold', selected.length > 0 ? 'text-ink' : 'text-mute')}>
          {selected.length === 0 ? t('lanes.noneSelected') : t('lanes.selected', { count: selected.length })}
        </span>
        {selected.length > 0 && !creating && (
          <button type="button" onClick={() => update([])} className="text-[0.78125rem] font-medium text-[#0F766E] hover:underline">
            {t('lanes.clear')}
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="release-branch" className="text-xs font-medium text-ink-2">
          {t('lanes.newBranch')}
        </label>
        <div
          className={cx(
            'stroke flex items-center gap-2 rounded-md px-2.5 py-2 [--stroke:#CBD5E1] focus-within:stroke-focus',
            creating ? 'bg-soft' : 'bg-white',
          )}
        >
          <GitBranch size={rem(13)} className="shrink-0 text-mute" />
          <input
            id="release-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            readOnly={creating}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[0.78125rem] font-medium text-ink outline-none"
          />
        </div>
        <p className="text-[0.71875rem] leading-[1.4] text-faint">
          {t('lanes.fromBase', { base: lane?.baseBranch ?? 'main' })}
        </p>
      </div>
      <button
        type="button"
        disabled={!canCreate}
        onClick={() => onCreate(branch.trim(), selected)}
        className={cx(
          'grid rounded-lg px-3.5 py-[0.5625rem] text-[0.8125rem] font-semibold',
          creating
            ? 'bg-ink-2 text-[#CBD5E1]'
            : canCreate
              ? 'hover-primary bg-ink text-white'
              : 'bg-[#E2E8F0] text-faint',
        )}
      >
        {/* Os dois rótulos ocupam o mesmo lugar: o botão fica do tamanho do maior e a coluna não muda de altura. */}
        <span className={cx('col-start-1 row-start-1 flex items-center justify-center gap-2', creating && 'invisible')}>
          <GitBranchPlus size={rem(14)} className="shrink-0" />
          {t('lanes.create')}
        </span>
        <span className={cx('col-start-1 row-start-1 flex items-center justify-center gap-2', !creating && 'invisible')}>
          <LoaderCircle size={rem(14)} className="shrink-0 animate-spin" />
          {t('lanes.creating')}
        </span>
      </button>
    </div>
  );

  return (
    <ColumnShell
      id="merged"
      count={merged.length}
      highlight={creating ? '#14B8A6' : state.status === 'failed' ? '#EF4444' : undefined}
      top={
        <RepoSelect
          tone="teal"
          repositories={repositories}
          value={repositoryId}
          onChange={onRepositoryChange}
          disabled={creating}
          className={cx(creating && 'opacity-55')}
        />
      }
      footer={createPanel}
    >

      <div className={cx('stroke flex flex-col overflow-hidden rounded-lg bg-white', creating && 'opacity-55')}>
        <div className="flex items-center gap-2.5 border-b border-line-row bg-soft px-3.5 py-2.5">
          <Checkbox
            label={t('lanes.selectAll')}
            state={allSelected ? 'on' : selected.length > 0 ? 'partial' : 'off'}
            disabled={creating || merged.length === 0}
            onChange={() => update(allSelected ? [] : merged.map((pr) => pr.id))}
          />
          <span className="text-[0.78125rem] font-medium text-ink-2">{t('lanes.selectAll')}</span>
        </div>
        {merged.map((pr, index) => {
          const isSelected = selected.includes(pr.id);
          const conflicted = state.status === 'failed' && state.conflictingId === pr.id;
          return (
            <div
              key={pr.id}
              onClick={() => !creating && toggle(pr.id)}
              className={cx(
                'flex gap-2.5 px-3.5 py-3',
                index < merged.length - 1 && 'border-b border-line-soft',
                !creating && 'cursor-pointer',
                // Linha marcada ou em conflito mantém a própria cor e só sobe um tom no hover.
                conflicted
                  ? 'bg-[#FEF2F2] hover:bg-[#FEE2E2]'
                  : isSelected
                    ? 'bg-[#F0FDFA] hover:bg-[#DDF7F1]'
                    : 'hover-row bg-white',
              )}
            >
              <span className="pt-px">
                <Checkbox
                  label={t('lanes.selectPr', { id: pr.id })}
                  state={isSelected ? 'on' : 'off'}
                  disabled={creating}
                  onChange={() => toggle(pr.id)}
                />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-[0.8125rem] font-medium leading-[1.35] text-ink">{pr.title}</p>
                <PrMeta pr={pr} />
              </div>
            </div>
          );
        })}
        {merged.length === 0 && repositoryId && (
          <p className={cx('px-3.5 py-3 text-xs', failed ? 'text-[#DC2626]' : 'text-mute')}>
            {failed ? t('lanes.loadFailed') : t('lanes.noMerged')}
          </p>
        )}
      </div>
    </ColumnShell>
  );
}

export function ReleaseColumn({
  repositories,
  repositoryId,
  onRepositoryChange,
  lane,
  loading,
  failed,
  highlight,
  now,
}: {
  repositories: Repo[];
  repositoryId: string | undefined;
  onRepositoryChange: (id: string) => void;
  lane: ReleaseLane | undefined;
  loading: boolean;
  failed: boolean;
  highlight: boolean;
  now: number;
}) {
  const navigate = useNavigate();
  const releaseUrl = repositoryId ? `/release?repo=${encodeURIComponent(repositoryId)}` : '/release';
  const expand = (
    <a
      href={releaseUrl}
      onClick={(event) => {
        // Clique simples troca de tela com fade; com Ctrl/meio, o link abre em outra aba.
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        void navigate(releaseUrl, { viewTransition: true });
      }}
      aria-label={t('lanes.openFullscreen')}
      title={t('lanes.openFullscreen')}
      className="stroke flex h-[1.625rem] w-[1.625rem] items-center justify-center rounded-md bg-white [--stroke:#DDD6FE] hover:bg-[#EDE9FE] hover:[--stroke:#C4B5FD]"
    >
      <Maximize2 size={rem(13)} className="text-[#7C3AED]" />
    </a>
  );

  if (loading) {
    return (
      <ColumnShell id="release" headerAction={expand}>
        <SkeletonCard />
        <SkeletonCard />
      </ColumnShell>
    );
  }

  const release = lane?.release;
  return (
    <ColumnShell id="release" count={release?.pullRequests.length ?? 0} highlight={highlight ? '#8B5CF6' : undefined} headerAction={expand}
      top={<RepoSelect tone="violet" repositories={repositories} value={repositoryId} onChange={onRepositoryChange} />}
    >
      {release ? (
        <>
          <div className="stroke flex flex-col gap-2 rounded-lg bg-white p-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <GitBranch size={rem(14)} className="shrink-0 text-[#7C3AED]" />
                <span className="truncate font-mono text-sm font-semibold text-ink">{release.name}</span>
              </div>
              <span className="shrink-0 rounded bg-[#EDE9FE] px-[0.4375rem] py-0.5 text-[0.6875rem] font-semibold text-[#6D28D9]">
                {t('common.latest')}
              </span>
            </div>
            <p className="text-xs leading-[1.4] text-mute">{releaseMeta(release, now)}</p>
          </div>
          {release.pullRequests.length > 0 ? (
            <div className="stroke flex flex-col overflow-hidden rounded-lg bg-white">
              {release.pullRequests.map((pr, index) => (
                <div
                  key={pr.id}
                  className={cx('flex gap-2.5 px-3.5 py-3', index < release.pullRequests.length - 1 && 'border-b border-line-soft')}
                >
                  <GitMerge size={rem(14)} className="shrink-0 text-[#8B5CF6]" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="text-[0.8125rem] font-medium leading-[1.35] text-ink">{pr.title}</p>
                    <PrMeta pr={pr} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <QuietNote>{t('lanes.noPrsInRelease')}</QuietNote>
          )}
        </>
      ) : (
        repositoryId &&
        (failed ? (
          <p className="px-1.5 pb-1 text-xs text-[#DC2626]">{t('lanes.loadFailed')}</p>
        ) : (
          <QuietNote>{t('lanes.noReleaseBranch')}</QuietNote>
        ))
      )}
    </ColumnShell>
  );
}
