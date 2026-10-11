import {
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns3,
  FolderGit2,
  GitMerge,
  LoaderCircle,
  RefreshCw,
  Search,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { ProjectView } from '../lib/api';
import { plural } from '../lib/format';
import { COLUMNS, type ColumnId } from './board';
import { Avatar, Checkbox, cx, Dot, LightMenu, MenuOption, useDropdown } from './ui';

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
  const { open, setOpen, ref } = useDropdown();
  return (
    <div ref={ref} className="relative self-start">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx('hover-dark flex items-center gap-2 rounded-lg bg-[#2A2D33] py-[7px] pl-3 pr-2.5', open && 'stroke-focus')}
      >
        <span className="text-sm font-semibold text-white">
          {current?.name ?? (loading ? 'Carregando…' : 'Sem projetos')}
        </span>
        {open ? <ChevronsDownUp size={14} className="text-[#A1A7B0]" /> : <ChevronsUpDown size={14} className="text-[#A1A7B0]" />}
      </button>
      {open && (
        <div
          role="menu"
          className="pop-in absolute left-0 top-full z-30 mt-[11px] flex w-[248px] flex-col gap-0.5 rounded-[10px] bg-[#2A2D33] p-1.5 shadow-[0_10px_28px_#0F172A40]"
        >
          <div className="px-2.5 pb-1.5 pt-2 text-[11px] font-semibold tracking-[0.6px] text-[#8B919A]">PROJETOS</div>
          {projects.map((project) => {
            const selected = project.id === current?.id;
            return (
              <button
                key={project.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                onClick={() => {
                  onSelect(project.id);
                  setOpen(false);
                }}
                className={cx(
                  'flex h-10 items-center gap-2.5 rounded-md px-2.5 text-left',
                  selected ? 'bg-[#3A3F48]' : 'hover-dark',
                )}
              >
                <span className={cx('min-w-0 flex-1 truncate text-[13px]', selected ? 'font-semibold text-white' : 'font-medium text-[#D1D5DB]')}>
                  {project.name}
                </span>
                <span className="text-xs text-[#8B919A]">{plural(project.openPullRequests, 'PR', 'PRs')}</span>
                {selected && <Check size={14} className="text-white" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
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
  const { open, setOpen, ref } = useDropdown();
  const current = options.find((o) => o.id === value);
  const hasPeople = options.some((o) => o.person);
  const pick = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx('stroke hover-surface flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-[7px]', open && 'stroke-focus')}
      >
        <Icon size={14} className="text-mute" />
        <span className="text-[13px] text-mute">{label}:</span>
        <span className="max-w-[140px] truncate text-[13px] font-medium text-ink">{current?.name ?? allLabel}</span>
        <ChevronDown size={14} className={cx('text-faint transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <LightMenu width={220}>
          <MenuOption
            selected={value === null}
            onSelect={() => pick(null)}
            leading={
              hasPeople ? (
                <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-[#F1F5F9]">
                  <Users size={12} className="text-mute" />
                </span>
              ) : undefined
            }
          >
            {allLabel}
          </MenuOption>
          {options.map((option) => (
            <MenuOption
              key={option.id}
              mono={!plain}
              selected={option.id === value}
              onSelect={() => pick(option.id)}
              leading={option.person && <Avatar {...option.person} />}
            >
              {option.name}
            </MenuOption>
          ))}
        </LightMenu>
      )}
    </div>
  );
}

export const AuthorIcon = User;
export const RepositoryIcon = FolderGit2;
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
  const { open, setOpen, ref } = useDropdown();
  const visible = COLUMNS.length - hidden.length;
  const toggle = (id: ColumnId) => {
    if (hidden.includes(id)) onChange(hidden.filter((h) => h !== id));
    // Sempre sobra pelo menos uma coluna.
    else if (visible > 1) onChange([...hidden, id]);
  };
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx('stroke hover-surface flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-[7px]', open && 'stroke-focus')}
      >
        <Columns3 size={14} className="text-ink-2" />
        <span className="text-[13px] font-medium text-ink">Colunas</span>
        <span className="rounded-lg bg-[#F1F5F9] px-1.5 py-px text-[11.5px] font-semibold text-ink-2">
          {visible}/{COLUMNS.length}
        </span>
        <ChevronDown size={14} className={cx('text-faint transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <LightMenu title="COLUNAS VISÍVEIS">
          {COLUMNS.map((column) => {
            const shown = !hidden.includes(column.id);
            return (
              <div
                key={column.id}
                role="menuitemcheckbox"
                aria-checked={shown}
                tabIndex={-1}
                onClick={() => toggle(column.id)}
                className={cx('hover-row flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2', !shown && 'bg-soft')}
              >
                <Checkbox state={shown ? 'on' : 'off'} label={column.name} onChange={() => toggle(column.id)} />
                <Dot color={column.color} />
                <span className={cx('min-w-0 flex-1 text-[13px] font-medium', shown ? 'text-ink' : 'text-faint')}>
                  {column.name}
                </span>
                <span className="text-xs text-faint">{counts[column.id] ?? ''}</span>
              </div>
            );
          })}
          <div className="h-px shrink-0 bg-line-soft" />
          <div className="flex items-center justify-between px-2.5 py-2">
            <button
              type="button"
              disabled={hidden.length === 0}
              onClick={() => onChange([])}
              className="text-[12.5px] font-semibold text-[#0F766E] disabled:text-faint"
            >
              Mostrar todas
            </button>
            <span className="text-xs text-faint">
              {hidden.length === 0 ? 'Nenhuma oculta' : plural(hidden.length, 'oculta', 'ocultas')}
            </span>
          </div>
        </LightMenu>
      )}
    </div>
  );
}

export function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="stroke flex w-[220px] items-center gap-2 rounded-lg bg-white px-2.5 py-[7px] focus-within:stroke-focus">
      <Search size={14} className="shrink-0 text-faint" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Buscar título, #id, autor"
        aria-label="Buscar título, #id, autor"
        className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
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
  const status = failed ? 'Falha ao sincronizar' : lastSync ? `Sincronizado ${lastSync}` : '';
  return (
    <>
      <button
        type="button"
        onClick={onRefresh}
        disabled={syncing}
        className={cx(
          'flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2',
          syncing ? 'bg-ink-2' : 'hover-primary bg-ink',
        )}
      >
        {syncing ? (
          <LoaderCircle size={14} className="animate-spin text-white" />
        ) : (
          <RefreshCw size={14} className="text-white" />
        )}
        <span className="text-[13px] font-semibold text-white">{syncing ? 'Sincronizando' : 'Atualizar'}</span>
      </button>
      <span
        className={cx('whitespace-nowrap text-xs', failed ? 'text-[#DC2626]' : 'text-faint')}
        title={failed && lastSync ? `Última sincronização ${lastSync}` : undefined}
        aria-live="polite"
      >
        {status}
      </span>
    </>
  );
}
