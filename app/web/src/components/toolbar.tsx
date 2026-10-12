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
import type { ProjectView } from '../lib/api';
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
import { t } from '../lib/i18n';
import { rem } from '../lib/units';

export function ProjectSwitcher({
  projects,
  current,
  loading,
  onSelect,
}: {
  projects: ProjectView[];
  current: ProjectView | undefined;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <Menu>
      <MenuTrigger className="hover-dark flex items-center gap-2 self-start rounded-lg bg-[#2A2D33] py-[0.4375rem] pl-3 pr-2.5 data-[state=open]:stroke-focus">
        <span className="text-sm font-semibold text-white">
          {current?.name ?? (loading ? t('common.loading') : t('board.noProjects'))}
        </span>
        <ChevronsUpDown size={rem(14)} className="text-[#A1A7B0] group-data-[state=open]:hidden" />
        <ChevronsDownUp size={rem(14)} className="hidden text-[#A1A7B0] group-data-[state=open]:block" />
      </MenuTrigger>
      <MenuContent tone="dark" width={248} offset={10} title={t('board.projects')} className="max-h-[min(26.25rem,var(--radix-dropdown-menu-content-available-height))]">
        <MenuRadioGroup value={current?.id} onValueChange={onSelect}>
          {projects.map((project) => {
            const selected = project.id === current?.id;
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
}: {
  hidden: ColumnId[];
  counts: Partial<Record<ColumnId, number>>;
  onChange: (hidden: ColumnId[]) => void;
}) {
  const visible = COLUMNS.length - hidden.length;
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
          {visible}/{COLUMNS.length}
        </span>
        <ChevronDown size={rem(14)} className="text-faint transition-transform group-data-[state=open]:rotate-180" />
      </MenuTrigger>
      <MenuContent title={t('board.visibleColumns')}>
        {COLUMNS.map((column) => {
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

export function SyncControls({
  syncing,
  failed,
  lastSync,
  onRefresh,
}: {
  syncing: boolean;
  failed: boolean;
  lastSync?: string;
  onRefresh: () => void;
}) {
  // Durante a sincronização só o botão muda; o status continua mostrando o último resultado.
  const status = failed ? t('common.syncFailed') : lastSync ? t('common.synced', { when: lastSync }) : '';
  return (
    <>
      <button
        type="button"
        onClick={onRefresh}
        disabled={syncing}
        className={cx(
          'grid shrink-0 rounded-lg px-3.5 py-2 text-[0.8125rem] font-semibold text-white',
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
      <span
        className={cx('whitespace-nowrap text-xs', failed ? 'text-[#DC2626]' : 'text-faint')}
        title={failed && lastSync ? t('common.lastSync', { when: lastSync }) : undefined}
        aria-live="polite"
      >
        {status}
      </span>
    </>
  );
}
