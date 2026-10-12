import { Check, ChevronDown, FolderGit2, Minus } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { initials } from '../lib/format';
import { t } from '../lib/i18n';
import { rem } from '../lib/units';

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
  const fontSize = size === 22 ? 'text-[0.59375rem]' : size === 30 ? 'text-[0.6875rem]' : 'text-[0.8125rem]';
  const showPhoto = !!avatarKey && failedKey !== avatarKey;
  return (
    <span
      className={cx(
        'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold',
        fontSize,
        isMe ? 'bg-[#DBEAFE] text-[#1E40AF]' : 'bg-[#E0E7FF] text-[#3730A3]',
      )}
      style={{ width: rem(size), height: rem(size) }}
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
        'stroke flex h-4 w-4 shrink-0 items-center justify-center rounded-[0.25rem]',
        filled ? 'bg-ink [--stroke:#0F172A]' : 'bg-white [--stroke:#CBD5E1]',
      )}
    >
      {state === 'on' && <Check size={rem(11)} className="text-white" />}
      {state === 'partial' && <Minus size={rem(11)} className="text-white" />}
    </button>
  );
}

// Menus suspensos: comportamento do Radix (teclado, foco, fechar com Esc ou clique fora, não sair da janela) com o
// visual do sistema.
export const Menu = ({ children, ...props }: DropdownMenu.DropdownMenuProps) => (
  <DropdownMenu.Root modal={false} {...props}>
    {children}
  </DropdownMenu.Root>
);

// O gatilho recebe data-state="open" enquanto o menu está aberto; `group` deixa os filhos reagirem a isso.
export const MenuTrigger = ({ className, ...props }: DropdownMenu.DropdownMenuTriggerProps) => (
  <DropdownMenu.Trigger className={cx('group', className)} {...props} />
);

const MENU_TONES = {
  light: 'stroke bg-white shadow-[0_0.5rem_1.5rem_#0F172A1F]',
  dark: 'bg-[#2A2D33] shadow-[0_0.625rem_1.75rem_#0F172A40]',
};

export function MenuContent({
  title,
  align = 'start',
  width = 260,
  tone = 'light',
  offset = 8,
  className,
  children,
  ...props
}: Omit<DropdownMenu.DropdownMenuContentProps, 'title'> & {
  title?: string;
  // Largura em px do design, ou a mesma do gatilho.
  width?: number | 'anchor';
  tone?: keyof typeof MENU_TONES;
  offset?: number;
}) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={offset}
        collisionPadding={8}
        className={cx(
          'pop-in z-40 flex max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] flex-col gap-0.5 overflow-y-auto rounded-[0.625rem] p-1.5 outline-none',
          MENU_TONES[tone],
          width === 'anchor' && 'w-[var(--radix-dropdown-menu-trigger-width)]',
          className,
        )}
        style={width === 'anchor' ? undefined : { width: rem(width) }}
        {...props}
      >
        {title && (
          <DropdownMenu.Label
            className={cx(
              'px-2.5 pb-1.5 pt-2 text-[0.6875rem] font-semibold',
              tone === 'light' ? 'tracking-[0.5px] text-faint' : 'tracking-[0.6px] text-[#8B919A]',
            )}
          >
            {title}
          </DropdownMenu.Label>
        )}
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

// Item em foco pelo teclado ou sob o ponteiro: o Radix marca com data-highlighted.
export const MENU_ITEM_LIGHT = 'cursor-default outline-none data-[highlighted]:bg-[var(--color-hover)]';
export const MENU_ITEM_DARK = 'cursor-default outline-none data-[highlighted]:bg-[var(--color-hover-dark)]';

// Opção de escolha única. Fica dentro de um <MenuRadioGroup>.
export function MenuOption({
  value,
  selected,
  mono,
  leading,
  children,
}: {
  value: string;
  selected: boolean;
  mono?: boolean;
  // Elemento antes do texto, como a foto de uma pessoa.
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[0.8125rem] font-medium text-ink',
        MENU_ITEM_LIGHT,
        selected && 'bg-soft',
        mono && 'font-mono text-[0.78125rem]',
      )}
    >
      {leading}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected && <Check size={rem(14)} className="shrink-0 text-ink-2" />}
    </DropdownMenu.RadioItem>
  );
}

export const MenuRadioGroup = DropdownMenu.RadioGroup;
export const MenuItem = DropdownMenu.Item;
export const MenuCheckboxItem = DropdownMenu.CheckboxItem;

// A caixa de seleção só desenhada, para dentro de um item que já é o controle.
export function CheckMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        'stroke flex h-4 w-4 shrink-0 items-center justify-center rounded-[0.25rem]',
        checked ? 'bg-ink [--stroke:#0F172A]' : 'bg-white [--stroke:#CBD5E1]',
      )}
    >
      {checked && <Check size={rem(11)} className="text-white" />}
    </span>
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
  const current = repositories.find((r) => r.id === value);
  return (
    <Menu>
      <MenuTrigger
        disabled={disabled}
        className={cx(
          'stroke hover-row flex w-full items-center gap-2 rounded-lg bg-white px-2.5 py-2 text-left data-[state=open]:stroke-focus',
          tone === 'violet' ? '[--stroke:#C4B5FD]' : '[--stroke:#E4E7EC]',
          className,
        )}
      >
        <FolderGit2 size={rem(14)} className={tone === 'violet' ? 'text-[#7C3AED]' : 'text-[#0F766E]'} />
        <span className="min-w-0 flex-1 truncate font-mono text-[0.78125rem] font-medium text-ink" title={current?.name}>
          {current?.name ?? t('lanes.selectRepository')}
        </span>
        <ChevronDown size={rem(14)} className="text-faint transition-transform group-data-[state=open]:rotate-180" />
      </MenuTrigger>
      <MenuContent width="anchor">
        <MenuRadioGroup value={value} onValueChange={onChange}>
          {repositories.map((repository) => (
            <MenuOption key={repository.id} value={repository.id} mono selected={repository.id === value}>
              {repository.name}
            </MenuOption>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />;
}

export function SkeletonCard() {
  return (
    <div className="stroke flex flex-col gap-3 rounded-lg bg-white p-3.5" aria-hidden>
      <div className="skeleton h-2.5 w-[6.875rem] rounded-[0.3125rem]" />
      <div className="skeleton h-3.5 w-full rounded-[0.4375rem]" />
      <div className="skeleton h-3.5 w-[10.625rem] max-w-full rounded-[0.4375rem]" />
      <div className="skeleton h-3 w-[5.625rem] rounded-md" />
      <div className="flex items-center justify-between pt-1.5">
        <div className="flex items-center gap-2">
          <div className="skeleton h-[1.375rem] w-[1.375rem] rounded-full" />
          <div className="skeleton h-2.5 w-20 rounded-[0.3125rem]" />
        </div>
        <div className="skeleton h-2.5 w-16 rounded-[0.3125rem]" />
      </div>
    </div>
  );
}
