import {
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns3,
  GitMerge,
  RefreshCw,
  Search,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';
import type { ProjectView } from '../lib/api';
import { ALL_PROJECTS } from '../lib/session';
import { COLUMNS, type ColumnId } from './board';
import {
  Avatar,
  CheckMark,
  cx,
  Dot,
  Menu,
  MENU_ITEM_DARK,
  MENU_ITEM_LIGHT,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuOption,
  MenuRadioGroup,
  MenuTrigger,
} from './ui';
import { elapsedLabel, useNow } from '../lib/format';
import { t } from '../lib/i18n';
import { DEFAULT_SYNC_INTERVAL, SYNC_INTERVALS, type SyncInterval } from '../lib/sync';
import { rem } from '../lib/units';

export function ProjectSwitcher({
  projects,
  current,
  loading,
  onSelect,
  organization,
  allProjects = false,
  open,
  onOpenChange,
}: {
  projects: ProjectView[];
  current: ProjectView | undefined;
  loading: boolean;
  onSelect: (id: string) => void;
  // Com várias organizações conectadas, o nome dela vem antes do projeto.
  organization?: string;
  // "Todos os projetos" está escolhido.
  allProjects?: boolean;
  // Aberto de fora, pelo botão "Escolher projeto" do board.
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const options = [
    // Com um projeto só, "todos" seria o mesmo board.
    ...(projects.length > 1
      ? [{ id: ALL_PROJECTS, name: t('board.allProjects'), openPullRequests: projects.reduce((sum, p) => sum + p.openPullRequests, 0) }]
      : []),
    ...projects,
  ];
  const selectedId = allProjects ? ALL_PROJECTS : current?.id;
  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger className="hover-dark flex items-center gap-2 self-start rounded-lg bg-[#2A2D33] py-[0.4375rem] pl-3 pr-2.5 data-[state=open]:stroke-focus">
        <span className="text-sm font-semibold text-white">
          {organization && <span className="font-normal text-[#A1A7B0]">{organization} / </span>}
          {allProjects ? t('board.allProjects') : (current?.name ?? (loading ? t('common.loading') : t('board.noProjects')))}
        </span>
        <ChevronsUpDown size={rem(14)} className="text-[#A1A7B0] group-data-[state=open]:hidden" />
        <ChevronsDownUp size={rem(14)} className="hidden text-[#A1A7B0] group-data-[state=open]:block" />
      </MenuTrigger>
      <MenuContent tone="dark" width={248} offset={10} title={t('board.projects')} className="max-h-[min(26.25rem,var(--radix-dropdown-menu-content-available-height))]">
        <MenuRadioGroup value={selectedId} onValueChange={onSelect}>
          {options.map((project) => {
            const selected = project.id === selectedId;
            return (
              <DropdownMenu.RadioItem
                key={project.id}
                value={project.id}
                className={cx('flex h-10 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left', MENU_ITEM_DARK, selected && 'bg-[#3A3F48]')}
              >
                <span className={cx('min-w-0 flex-1 truncate text-[0.8125rem]', selected ? 'font-semibold text-white' : 'font-medium text-[#D1D5DB]')}>
                  {project.name}
                </span>
                <span className="text-xs text-[#8B919A]">{t('common.prCount', { count: project.openPullRequests })}</span>
                {selected && <Check size={rem(14)} className="text-white" />}
              </DropdownMenu.RadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

export interface FilterOption {
  id: string;
  name: string;
  // Quando a opção é uma pessoa: mostra a foto dela ao lado do nome.
  person?: { name: string; isMe: boolean; avatarKey?: string };
}

export function FilterSelect({
  icon: Icon,
  label,
  allLabel,
  options,
  value,
  onChange,
  plain,
}: {
  icon: LucideIcon;
  label: string;
  allLabel: string;
  options: FilterOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  // Opções em texto comum, em vez da fonte monoespaçada usada para repositórios e branches.
  plain?: boolean;
}) {
  const current = options.find((o) => o.id === value);
  const hasPeople = options.some((o) => o.person);
  // O grupo de opções trabalha com texto; a opção "todos" é o texto vazio.
  const ALL = '';
  return (
    <Menu>
      <MenuTrigger className="stroke hover-surface flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-[0.4375rem] data-[state=open]:stroke-focus">
        <Icon size={rem(14)} className="text-mute" />
        <span className="text-[0.8125rem] text-mute">{label}:</span>
        <span className="max-w-[8.75rem] truncate text-[0.8125rem] font-medium text-ink">{current?.name ?? allLabel}</span>
        <ChevronDown size={rem(14)} className="text-faint transition-transform group-data-[state=open]:rotate-180" />
      </MenuTrigger>
      <MenuContent width={220}>
        <MenuRadioGroup value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
          <MenuOption
            value={ALL}
            selected={value === null}
            leading={
              hasPeople ? (
                <span className="flex h-[1.375rem] w-[1.375rem] shrink-0 items-center justify-center rounded-full bg-[#F1F5F9]">
                  <Users size={rem(12)} className="text-mute" />
                </span>
              ) : undefined
            }
          >
            {allLabel}
          </MenuOption>
          {options.map((option) => (
            <MenuOption
              key={option.id}
              value={option.id}
              mono={!plain}
              selected={option.id === value}
              leading={option.person && <Avatar {...option.person} />}
            >
              {option.name}
            </MenuOption>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

export const AuthorIcon = User;
export const TargetIcon = GitMerge;

export function ColumnsDropdown({
  hidden,
  counts,
  onChange,
  columns = COLUMNS,
}: {
  hidden: ColumnId[];
  counts: Partial<Record<ColumnId, number>>;
  onChange: (hidden: ColumnId[]) => void;
  // As colunas que o board tem agora (com todos os projetos, só as de PR aberto).
  columns?: typeof COLUMNS;
}) {
  const visible = columns.filter((column) => !hidden.includes(column.id)).length;
  const toggle = (id: ColumnId) => {
    if (hidden.includes(id)) onChange(hidden.filter((h) => h !== id));
    // Sempre sobra pelo menos uma coluna.
    else if (visible > 1) onChange([...hidden, id]);
  };
  // Marcar e desmarcar não fecha o menu.
  const stayOpen = (event: Event) => event.preventDefault();
  return (
    <Menu>
      <MenuTrigger className="stroke hover-surface flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-[0.4375rem] data-[state=open]:stroke-focus">
        <Columns3 size={rem(14)} className="text-ink-2" />
        <span className="text-[0.8125rem] font-medium text-ink">{t('board.columns')}</span>
        <span className="rounded-lg bg-[#F1F5F9] px-1.5 py-px text-[0.71875rem] font-semibold text-ink-2">
          {visible}/{columns.length}
        </span>
        <ChevronDown size={rem(14)} className="text-faint transition-transform group-data-[state=open]:rotate-180" />
      </MenuTrigger>
      <MenuContent title={t('board.visibleColumns')}>
        {columns.map((column) => {
          const shown = !hidden.includes(column.id);
          return (
            <MenuCheckboxItem
              key={column.id}
              checked={shown}
              // A última coluna visível não pode ser escondida.
              disabled={shown && visible === 1}
              onCheckedChange={() => toggle(column.id)}
              onSelect={stayOpen}
              className={cx('flex items-center gap-2.5 rounded-md px-2.5 py-2', MENU_ITEM_LIGHT, !shown && 'bg-soft')}
            >
              <CheckMark checked={shown} />
              <Dot color={column.color} />
              <span className={cx('min-w-0 flex-1 text-[0.8125rem] font-medium', shown ? 'text-ink' : 'text-faint')}>{column.name}</span>
              <span className="text-xs text-faint">{counts[column.id] ?? ''}</span>
            </MenuCheckboxItem>
          );
        })}
        <div className="h-px shrink-0 bg-line-soft" />
        <div className="flex items-center justify-between px-2.5 py-2">
          <MenuItem
            disabled={hidden.length === 0}
            onSelect={(event) => {
              stayOpen(event);
              onChange([]);
            }}
            className="cursor-default rounded text-[0.78125rem] font-semibold text-[#0F766E] outline-none data-[disabled]:text-faint data-[highlighted]:underline"
          >
            {t('board.showAll')}
          </MenuItem>
          <span className="text-xs text-faint">
            {hidden.length === 0 ? t('board.noneHidden') : t('board.hidden', { count: hidden.length })}
          </span>
        </div>
      </MenuContent>
    </Menu>
  );
}

export function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="stroke flex w-[13.75rem] items-center gap-2 rounded-lg bg-white px-2.5 py-[0.4375rem] focus-within:stroke-focus">
      <Search size={rem(14)} className="shrink-0 text-faint" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t('board.search')}
        aria-label={t('board.search')}
        className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink outline-none placeholder:text-faint"
      />
    </label>
  );
}

// Menu "Atualizar automaticamente": o chevron ao lado do Atualizar, no board e na release.
export function SyncIntervalMenu({
  value,
  onChange,
  className,
  iconClassName,
  extra,
}: {
  value: SyncInterval;
  onChange: (value: SyncInterval) => void;
  className: string;
  iconClassName?: string;
  // Espaço para outras opções de sincronização, como o aviso de PR novo que depende de mim (#20).
  extra?: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger className={className} aria-label={t('sync.title')} title={t('sync.title')}>
        <ChevronDown size={rem(14)} className={cx('transition-transform group-data-[state=open]:rotate-180', iconClassName)} />
      </MenuTrigger>
      <MenuContent align="end" width={260} title={t('sync.title')}>
        <MenuRadioGroup value={String(value)} onValueChange={(next) => onChange(Number(next) as SyncInterval)}>
          {SYNC_INTERVALS.map((minutes) => (
            <MenuOption key={minutes} value={String(minutes)} selected={minutes === value}>
              {minutes === 0 ? t('sync.off') : t('sync.every', { count: minutes })}
              {minutes === DEFAULT_SYNC_INTERVAL && <span className="text-faint"> · {t('sync.default')}</span>}
            </MenuOption>
          ))}
        </MenuRadioGroup>
        <div className="h-px shrink-0 bg-line-soft" />
        {extra}
        <p className="px-2.5 py-2 text-xs leading-[1.45] text-faint">{t('sync.pauseNote')}</p>
      </MenuContent>
    </Menu>
  );
}

// Anel que se completa até a próxima sincronização automática.
function SyncRing({ progress }: { progress: number }) {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 -rotate-90" aria-hidden>
      <circle cx="6" cy="6" r="4.5" fill="none" strokeWidth="2" className="stroke-line" />
      <circle
        cx="6"
        cy="6"
        r="4.5"
        fill="none"
        strokeWidth="2"
        pathLength={100}
        strokeDasharray="100"
        strokeDashoffset={100 * (1 - progress)}
        className="stroke-[#0F766E] transition-[stroke-dashoffset] duration-1000 ease-linear"
      />
    </svg>
  );
}

// Duas linhas: há quanto tempo sincronizou e quando sincroniza de novo.
// `syncedAt` é a hora do servidor; `updatedAt`, quando esta aba recebeu o dado, que é de onde o intervalo conta.
export function SyncStatus({
  failed,
  syncedAt,
  updatedAt,
  interval,
}: {
  failed: boolean;
  syncedAt?: string;
  updatedAt: number;
  interval: SyncInterval;
}) {
  // Atualiza a cada poucos segundos só aqui dentro, para o anel andar sem redesenhar a página.
  const now = useNow(5_000);
  const lastSync = syncedAt && elapsedLabel(syncedAt, now);
  // Durante a sincronização só o botão muda; o status continua mostrando o último resultado.
  const status = failed ? t('common.syncFailed') : lastSync ? t('common.synced', { when: lastSync }) : '';
  const ms = interval * 60_000;
  const remaining = updatedAt + ms - now;
  return (
    <span className="flex flex-col gap-0.5 whitespace-nowrap text-xs" aria-live="polite">
      <span
        className={failed ? 'text-[#DC2626]' : 'text-faint'}
        title={failed && lastSync ? t('common.lastSync', { when: lastSync }) : undefined}
      >
        {status || ' '}
      </span>
      {updatedAt > 0 && (
        <span className="flex items-center gap-1.5 text-faint">
          {interval === 0 ? (
            t('sync.autoOff')
          ) : (
            <>
              <SyncRing progress={Math.min(1, Math.max(0, 1 - remaining / ms))} />
              {remaining < 60_000 ? t('sync.nextSoon') : t('sync.nextIn', { count: Math.ceil(remaining / 60_000) })}
            </>
          )}
        </span>
      )}
    </span>
  );
}

export function SyncControls({
  syncing,
  failed,
  syncedAt,
  updatedAt,
  interval,
  onIntervalChange,
  onRefresh,
}: {
  syncing: boolean;
  failed: boolean;
  syncedAt?: string;
  updatedAt: number;
  interval: SyncInterval;
  onIntervalChange: (value: SyncInterval) => void;
  onRefresh: () => void;
}) {
  return (
    <>
      <div className="flex shrink-0">
        <button
          type="button"
          onClick={onRefresh}
          disabled={syncing}
          className={cx(
            'grid rounded-l-lg px-3.5 py-2 text-[0.8125rem] font-semibold text-white',
            // Sincronizando, o botão fica na cor do hover.
            syncing ? 'bg-[#1E293B]' : 'hover-primary bg-ink',
          )}
        >
          {/* Os dois rótulos ocupam o mesmo lugar: o botão não muda de largura a cada sincronização. */}
          <span className={cx('col-start-1 row-start-1 flex items-center justify-center gap-1.5', syncing && 'invisible')}>
            <RefreshCw size={rem(14)} />
            {t('common.refresh')}
          </span>
          <span className={cx('col-start-1 row-start-1 flex items-center justify-center gap-1.5', !syncing && 'invisible')}>
            <RefreshCw size={rem(14)} className={cx(syncing && 'animate-spin')} />
            {t('common.syncing')}
          </span>
        </button>
        <SyncIntervalMenu
          value={interval}
          onChange={onIntervalChange}
          className="hover-primary flex items-center rounded-r-lg border-l border-white/20 bg-ink px-2 text-white data-[state=open]:bg-[#1E293B]"
        />
      </div>
      <SyncStatus failed={failed} syncedAt={syncedAt} updatedAt={updatedAt} interval={interval} />
    </>
  );
}
