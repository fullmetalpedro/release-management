import { CircleCheck, ExternalLink, Eye, Inbox as InboxIcon, RefreshCw, TriangleAlert, Undo2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AzureDevOpsLogo, GitHubLogo } from '../components/logos';
import { TopBar } from '../components/TopBar';
import { Avatar, Checkbox, cx } from '../components/ui';
import type { Inbox, InboxItem } from '../lib/api';
import { age, authorLabel, elapsedLabel, shortDate, useNow, useStoredState } from '../lib/format';
import { t } from '../lib/i18n';
import { useInbox } from '../lib/inbox';
import { useSession } from '../lib/session';
import { rem } from '../lib/units';
import { sortCards, waitingBand } from '../lib/waiting';

const PROVIDER_LOGO: Record<Inbox['connections'][number]['provider'], (size: number) => ReactNode> = {
  'azure-devops': (size) => <AzureDevOpsLogo size={size} />,
  github: (size) => <GitHubLogo size={size} />,
};

// A idade na cor da faixa de espera, como o badge do board.
const BAND_TEXT = { fresh: 'text-mute font-medium', attention: 'text-[#B45309] font-semibold', stale: 'text-[#DC2626] font-semibold' };

function ReasonChip({ reason }: { reason: InboxItem['reason'] }) {
  if (reason === 'waiting-author') {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap rounded bg-[#FFEDD5] px-2 py-1 text-xs font-medium text-[#9A3412]">
        <Undo2 size={rem(12)} />
        {t('card.waitingAuthor')}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap rounded bg-[#FEF3C7] px-2 py-1 text-xs font-medium text-[#92400E]">
      <Eye size={rem(12)} />
      {t('card.reviewer')}
    </span>
  );
}

function InboxRow({ item, now }: { item: InboxItem; now: number }) {
  return (
    <a
      href={item.webUrl}
      target="_blank"
      rel="noreferrer"
      className="grid grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_auto] items-center gap-x-5 gap-y-2 border-t border-line-soft px-5 py-3 hover-surface md:grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_10.5rem_10rem_3rem_3.5rem_1rem]"
    >
      <span className="truncate font-mono text-[0.75rem] text-mute">
        {item.repository.name} <span className="text-faint">#{item.id}</span>
      </span>
      <span className="truncate text-sm font-semibold text-ink">{item.title}</span>
      <span className="md:justify-self-start">
        <ReasonChip reason={item.reason} />
      </span>
      <span className="col-span-2 flex min-w-0 items-center gap-2 md:col-span-1">
        <Avatar name={item.author.name} isMe={item.author.isMe} avatarKey={item.author.avatarKey} />
        <span className="truncate text-[0.8125rem] text-ink-2">{authorLabel(item.author)}</span>
      </span>
      <span className={cx('text-right text-[0.8125rem]', BAND_TEXT[waitingBand(item.waitingSince, now)])} title={t('inbox.waitingFor')}>
        {age(item.waitingSince, now)}
      </span>
      <span className="flex items-center gap-1 text-[0.8125rem] text-mute" title={t('card.approvals')}>
        <CircleCheck size={rem(13)} />
        {item.approvals}/{item.reviewers}
      </span>
      <ExternalLink size={rem(14)} className="hidden text-faint md:block" aria-label={t('inbox.open')} />
    </a>
  );
}

type Role = 'reviewer' | 'author';

export function InboxPage() {
  const inbox = useInbox();
  const { me } = useSession();
  const navigate = useNavigate();
  const now = useNow();
  const [org, setOrg] = useStoredState<string | null>('rm.inbox.org', null);
  const [roles, setRoles] = useStoredState<Role[]>('rm.inbox.roles', ['reviewer', 'author'], (value): value is Role[] =>
    Array.isArray(value) && value.every((role) => role === 'reviewer' || role === 'author'),
  );

  const data = inbox.data;
  const connections = data?.connections ?? [];
  // A caixa de entrada pode ser a primeira a ver um token recusado: o menu de contas precisa saber para pedir a
  // reconexão.
  const queryClient = useQueryClient();
  const staleAccounts = connections.some(
    (connection) => connection.status === 'expired' && !me.accounts.find((account) => account.id === connection.id)?.expiredAt,
  );
  useEffect(() => {
    if (staleAccounts) void queryClient.invalidateQueries({ queryKey: ['me'] });
  }, [staleAccounts, queryClient]);
  const orgFilter = connections.some((connection) => connection.id === org) ? org : null;
  const items = useMemo(
    () =>
      sortCards(
        (data?.items ?? []).filter(
          (item) =>
            (!orgFilter || item.connectionId === orgFilter) &&
            roles.includes(item.reason === 'waiting-author' ? 'author' : 'reviewer'),
        ),
        'oldest',
      ) as InboxItem[],
    [data, orgFilter, roles],
  );
  // Agrupada por organização e projeto, na ordem das organizações; dentro do grupo, quem espera há mais tempo primeiro.
  const groups = useMemo(() => {
    const byKey = new Map<string, { connection: Inbox['connections'][number]; project: string; items: InboxItem[] }>();
    for (const connection of connections) {
      for (const item of items.filter((candidate) => candidate.connectionId === connection.id)) {
        const key = `${connection.id}/${item.project.id}`;
        if (!byKey.has(key)) byKey.set(key, { connection, project: item.project.name, items: [] });
        byKey.get(key)!.items.push(item);
      }
    }
    return [...byKey.values()].sort((a, b) =>
      connections.indexOf(a.connection) - connections.indexOf(b.connection) || a.project.localeCompare(b.project),
    );
  }, [connections, items]);

  const total = data?.items.length ?? 0;
  const loaded = connections.filter((connection) => connection.status === 'ok');
  const toggle = (role: Role) => setRoles(roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role]);
  const reconnect = (connection: Inbox['connections'][number]) =>
    navigate('/login', { state: { connect: { provider: connection.provider, account: connection.account } } });

  return (
    <div data-page="inbox" className="flex h-full min-h-[35rem] flex-col">
      <TopBar />
      <main className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-8 pb-8 pt-7">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[1.75rem] font-bold tracking-[-0.4px] text-ink">{t('inbox.title')}</h1>
            <p className="text-sm text-mute">
              {inbox.isPending
                ? t('common.loading')
                : t('inbox.subtitle', { count: total, organizations: t('inbox.organizations', { count: loaded.length }) })}
              {data && <span className="text-faint"> · {t('inbox.synced', { when: elapsedLabel(data.syncedAt, now) })}</span>}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void inbox.refetch()}
            disabled={inbox.isFetching}
            className="stroke hover-surface flex items-center gap-1.5 rounded-lg bg-white px-3 py-[0.4375rem] text-[0.8125rem] font-medium text-ink-2 disabled:opacity-60"
          >
            <RefreshCw size={rem(14)} className={cx(inbox.isFetching && 'animate-spin')} />
            {t('inbox.refresh')}
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label={t('inbox.organizationFilter')} className="flex flex-wrap gap-2">
            <OrgChip selected={!orgFilter} onClick={() => setOrg(null)} label={t('inbox.all')} count={total} />
            {loaded.map((connection) => (
              <OrgChip
                key={connection.id}
                selected={orgFilter === connection.id}
                onClick={() => setOrg(connection.id)}
                label={connection.account}
                count={connection.count}
                logo={PROVIDER_LOGO[connection.provider](14)}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {(['reviewer', 'author'] as const).map((role) => (
              <label key={role} className="stroke flex cursor-pointer items-center gap-2 rounded-lg bg-white px-3 py-[0.4375rem]">
                <Checkbox state={roles.includes(role) ? 'on' : 'off'} onChange={() => toggle(role)} label={t(`inbox.as.${role}`)} />
                {/* O label leva o clique do texto até a caixa, que é quem alterna. */}
                <span className="text-[0.8125rem] font-medium text-ink-2">
                  {t(`inbox.as.${role}`)}
                </span>
              </label>
            ))}
          </div>
        </div>

        {connections
          .filter((connection) => connection.status !== 'ok' || connection.failedProjects.length > 0 || connection.skippedProjects > 0)
          .map((connection) => {
            const text =
              connection.status === 'expired'
                ? t('inbox.expired', { account: connection.account, date: shortDate(connection.expiredAt) })
                : connection.status === 'failed'
                  ? t('inbox.failed', { account: connection.account, reason: connection.reason ?? '' })
                  : [
                      ...connection.failedProjects.map((failed) => t('inbox.projectFailed', { account: connection.account, project: failed.project })),
                      ...(connection.skippedProjects > 0 ? [t('inbox.skipped', { account: connection.account, count: connection.skippedProjects })] : []),
                    ].join(' ');
            return (
              <div key={connection.id} role="status" className="stroke flex items-center gap-2.5 rounded-[0.625rem] bg-[#FFFBEB] px-3.5 py-2.5 [--stroke:#FDE68A]">
                <TriangleAlert size={rem(15)} className="shrink-0 text-[#B45309]" />
                <p className="min-w-0 flex-1 text-[0.8125rem] text-[#92400E]">{text}</p>
                {connection.status === 'expired' && me.mode === 'pat' && (
                  <button
                    type="button"
                    onClick={() => reconnect(connection)}
                    className="hover-primary shrink-0 rounded-md bg-ink px-2.5 py-1 text-xs font-semibold text-white"
                  >
                    {t('account.reconnect')}
                  </button>
                )}
              </div>
            );
          })}

        {inbox.isError ? (
          <p role="alert" className="text-sm text-[#B91C1C]">{inbox.error.message}</p>
        ) : inbox.isPending ? (
          <div className="stroke h-48 animate-pulse rounded-xl bg-white" />
        ) : groups.length === 0 ? (
          <div className="stroke flex flex-col items-center gap-2 rounded-xl bg-white px-6 py-12 text-center">
            <InboxIcon size={rem(22)} className="text-[#16A34A]" />
            <p className="text-sm font-semibold text-ink">{t('inbox.emptyTitle')}</p>
            <p className="text-[0.8125rem] text-mute">{total > 0 ? t('inbox.emptyFiltered') : t('inbox.emptyBody')}</p>
          </div>
        ) : (
          <div className="stroke overflow-hidden rounded-xl bg-white">
            {groups.map((group) => (
              <section key={`${group.connection.id}/${group.project}`} aria-label={`${group.connection.account} / ${group.project}`}>
                <header className="flex items-center justify-between gap-3 border-t border-line-soft bg-canvas px-5 py-2.5 first:border-t-0">
                  <span className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
                    {PROVIDER_LOGO[group.connection.provider](14)}
                    <span className="text-mute">{group.connection.account} /</span>
                    <span className="truncate font-semibold text-ink">{group.project}</span>
                  </span>
                  <span className="text-xs text-faint">{t('common.prCount', { count: group.items.length })}</span>
                </header>
                {group.items.map((item) => (
                  <InboxRow key={`${item.repository.id}#${item.id}`} item={item} now={now} />
                ))}
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function OrgChip({ selected, onClick, label, count, logo }: { selected: boolean; onClick: () => void; label: string; count: number; logo?: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cx(
        'flex items-center gap-1.5 rounded-full px-3 py-[0.375rem] text-[0.8125rem] font-medium',
        selected ? 'bg-ink text-white' : 'stroke hover-surface bg-white text-ink-2',
      )}
    >
      {logo}
      {label}
      <span className={selected ? 'text-[#CBD5E1]' : 'text-faint'}>{count}</span>
    </button>
  );
}
