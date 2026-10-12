import { Check, ChevronDown, FolderGit2, Minus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { initials } from '../lib/format';
import { t } from '../lib/i18n';

export function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

// Foto de perfil quando o provedor tem uma; as iniciais ficam por baixo e aparecem enquanto ela carrega ou se falhar.
export function Avatar({
  name,
  isMe,
  avatarKey,
  size = 22,
}: {
  name: string;
  isMe: boolean;
  avatarKey?: string;
  size?: 22 | 30 | 36;
}) {
  const [failedKey, setFailedKey] = useState<string>();
  const [loadedKey, setLoadedKey] = useState<string>();
  const fontSize = size === 22 ? 'text-[9.5px]' : size === 30 ? 'text-[11px]' : 'text-[13px]';
  const showPhoto = !!avatarKey && failedKey !== avatarKey;
  return (
    <span
      className={cx(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold',
        fontSize,
        isMe ? 'bg-[#DBEAFE] text-[#1E40AF]' : 'bg-[#E0E7FF] text-[#3730A3]',
      )}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {initials(name)}
      {showPhoto && (
        <img
          src={`/api/avatars/${encodeURIComponent(avatarKey)}`}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoadedKey(avatarKey)}
          onError={() => setFailedKey(avatarKey)}
          className={cx(
            'absolute inset-0 h-full w-full object-cover transition-opacity duration-200',
            loadedKey === avatarKey ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </span>
  );
}

export type CheckState = 'off' | 'on' | 'partial';

export function Checkbox({
  state,
  disabled,
  onChange,
  label,
}: {
  state: CheckState;
  disabled?: boolean;
  onChange?: () => void;
  label: string;
}) {
  const filled = state !== 'off';
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'partial' ? 'mixed' : state === 'on'}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onChange?.();
      }}
      className={cx(
        'stroke flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px]',
        filled ? 'bg-ink [--stroke:#0F172A]' : 'bg-white [--stroke:#CBD5E1]',
      )}
    >
      {state === 'on' && <Check size={11} className="text-white" />}
      {state === 'partial' && <Minus size={11} className="text-white" />}
    </button>
  );
}

// Abre/fecha um menu ancorado; fecha com Esc, com clique fora ou quando o foco sai dele pelo teclado.
export function useDropdown<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false);
  const ref = useRef<T>(null);
  // Conteúdo do menu renderizado fora do gatilho (portal): clicar nele não fecha o menu.
  const portalRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (!!ref.current?.contains(target) || !!portalRef.current?.contains(target));
    const onPointer = (event: PointerEvent) => {
      if (!inside(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // O item em foco some junto com o menu; o foco volta para o botão que o abriu, em vez de se perder.
      if (inside(document.activeElement)) ref.current?.querySelector<HTMLElement>('button, [href], [tabindex]')?.focus();
      setOpen(false);
    };
    const onFocus = (event: FocusEvent) => {
      if (!inside(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
    };
  }, [open]);
  return { open, setOpen, ref, portalRef };
}

export function LightMenu({
  title,
  align = 'left',
  width = 260,
  children,
}: {
  title?: string;
  align?: 'left' | 'right';
  width?: number | 'anchor';
  children: ReactNode;
}) {
  return (
    <div
      role="menu"
      className={cx(
        'stroke pop-in absolute top-full z-30 mt-2 flex max-h-[320px] flex-col overflow-y-auto rounded-[10px] bg-white p-1.5 shadow-[0_8px_24px_#0F172A1F]',
        align === 'left' ? 'left-0' : 'right-0',
        width === 'anchor' && 'w-full',
      )}
      style={width === 'anchor' ? undefined : { width }}
    >
      {title && (
        <div className="px-2.5 pb-1.5 pt-2 text-[11px] font-semibold tracking-[0.5px] text-faint">{title}</div>
      )}
      {children}
    </div>
  );
}

export function MenuOption({
  selected,
  onSelect,
  mono,
  leading,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  mono?: boolean;
  // Elemento antes do texto, como a foto de uma pessoa.
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onSelect}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium text-ink hover-row',
        selected && 'bg-soft',
        mono && 'font-mono text-[12.5px]',
      )}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check size={14} className="shrink-0 text-ink-2" />}
    </button>
  );
}

export function RepoSelect({
  repositories,
  value,
  onChange,
  tone,
  disabled,
  className,
}: {
  repositories: { id: string; name: string }[];
  value: string | undefined;
  onChange: (id: string) => void;
  tone: 'teal' | 'violet';
  disabled?: boolean;
  className?: string;
}) {
  const { open, setOpen, ref } = useDropdown();
  const current = repositories.find((r) => r.id === value);
  return (
    <div ref={ref} className={cx('relative', className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        className={cx(
          'stroke hover-row flex w-full items-center gap-2 rounded-lg bg-white px-2.5 py-2 text-left',
          open ? 'stroke-focus' : tone === 'violet' ? '[--stroke:#C4B5FD]' : '[--stroke:#E4E7EC]',
        )}
      >
        <FolderGit2 size={14} className={tone === 'violet' ? 'text-[#7C3AED]' : 'text-[#0F766E]'} />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-medium text-ink">
          {current?.name ?? t('lanes.selectRepository')}
        </span>
        <ChevronDown size={14} className={cx('text-faint transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <LightMenu width="anchor">
          {repositories.map((repository) => (
            <MenuOption
              key={repository.id}
              mono
              selected={repository.id === value}
              onSelect={() => {
                onChange(repository.id);
                setOpen(false);
              }}
            >
              {repository.name}
            </MenuOption>
          ))}
        </LightMenu>
      )}
    </div>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />;
}

export function SkeletonCard() {
  return (
    <div className="stroke flex flex-col gap-3 rounded-lg bg-white p-3.5" aria-hidden>
      <div className="skeleton h-2.5 w-[110px] rounded-[5px]" />
      <div className="skeleton h-3.5 w-full rounded-[7px]" />
      <div className="skeleton h-3.5 w-[170px] max-w-full rounded-[7px]" />
      <div className="skeleton h-3 w-[90px] rounded-md" />
      <div className="flex items-center justify-between pt-1.5">
        <div className="flex items-center gap-2">
          <div className="skeleton h-[22px] w-[22px] rounded-full" />
          <div className="skeleton h-2.5 w-20 rounded-[5px]" />
        </div>
        <div className="skeleton h-2.5 w-16 rounded-[5px]" />
      </div>
    </div>
  );
}
