import { Ban, Check, ChevronDown, Ellipsis, FolderGit2, Plus } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useState } from 'react';
import { HexColorPicker } from 'react-colorful';
import { localeTag, t } from '../lib/i18n';
import { cx } from './ui';
import { rem } from '../lib/units';

// Cores da seleção rápida, na ordem em que aparecem no seletor.
export const PALETTE = [
  { id: 'blue', hex: '#3B82F6' },
  { id: 'cyan', hex: '#06B6D4' },
  { id: 'teal', hex: '#14B8A6' },
  { id: 'lime', hex: '#65A30D' },
  { id: 'indigo', hex: '#6366F1' },
  { id: 'purple', hex: '#A855F7' },
  { id: 'pink', hex: '#EC4899' },
  { id: 'graphite', hex: '#475569' },
] as const;

const MAX_CUSTOM_COLORS = 16;
const HEX = /^#[0-9A-F]{6}$/;

export const isHexColor = (value: unknown): value is string => typeof value === 'string' && HEX.test(value);

type Rgb = [number, number, number];

const toHex = (rgb: Rgb) => `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const toRgb = (hex: string): Rgb => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)) as Rgb;

function Swatch({ hex, label, selected, onPick }: { hex: string; label: string; selected: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={selected}
      onClick={onPick}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-110"
      style={{ backgroundColor: hex }}
    >
      {selected && <Check size={rem(12)} className="text-white" />}
    </button>
  );
}

function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="flex w-[2.375rem] flex-col items-center gap-1">
      <input
        value={value}
        inputMode="numeric"
        onChange={(event) => onChange(Math.min(255, Number(event.target.value.replace(/\D/g, '')) || 0))}
        className="stroke h-7 w-full rounded-md bg-white text-center font-mono text-[0.71875rem] font-medium text-ink"
      />
      <span className="text-[0.625rem] font-semibold tracking-[0.5px] text-faint">{label}</span>
    </label>
  );
}

// Editor de cor personalizada: a área de saturação e brilho e a faixa de matiz são do react-colorful (arrasto, toque
// e teclado); os campos HEX e RGB ficam em sincronia com ele.
function CustomColorEditor({ initial, onCancel, onAdd }: { initial: string; onCancel: () => void; onAdd: (hex: string) => void }) {
  const [hex, setHex] = useState(initial);
  const [hexText, setHexText] = useState(initial);
  const rgb = toRgb(hex);
  const change = (next: string) => {
    const normalized = next.toUpperCase();
    setHex(normalized);
    setHexText(normalized);
  };
  const setChannel = (index: number, value: number) => {
    const next = [...rgb] as Rgb;
    next[index] = value;
    change(toHex(next));
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="h-px bg-[#F1F5F9]" />
      <HexColorPicker className="repo-color-picker" color={hex} onChange={change} />
      <div className="flex gap-1.5">
        <label className="flex min-w-0 flex-1 flex-col items-center gap-1">
          <input
            value={hexText}
            spellCheck={false}
            maxLength={7}
            onChange={(event) => {
              const typed = event.target.value.trim().toUpperCase();
              const next = typed.startsWith('#') ? typed : `#${typed}`;
              setHexText(next);
              if (isHexColor(next)) setHex(next);
            }}
            onBlur={() => setHexText(hex)}
            className="stroke h-7 w-full rounded-md bg-white text-center font-mono text-[0.71875rem] font-medium text-ink"
          />
          <span className="text-[0.625rem] font-semibold tracking-[0.5px] text-faint">HEX</span>
        </label>
        {(['R', 'G', 'B'] as const).map((label, index) => (
          <NumberField key={label} label={label} value={rgb[index]!} onChange={(value) => setChannel(index, value)} />
        ))}
      </div>
      <div className="flex items-center justify-end gap-3">
        <button type="button" onClick={onCancel} className="text-[0.78125rem] font-medium text-mute hover:text-ink">
          {t('colors.cancel')}
        </button>
        <button type="button" onClick={() => onAdd(hex)} className="hover-primary rounded-md bg-ink px-3 py-1.5 text-[0.78125rem] font-semibold text-white">
          {t('colors.add')}
        </button>
      </div>
    </div>
  );
}

function ColorPicker({
  value,
  customColors,
  sharedWith,
  onPick,
  onAddCustom,
}: {
  value: string | undefined;
  customColors: string[];
  // Outros repositórios que já usam a cor escolhida. Repetir cor é permitido; o seletor só avisa.
  sharedWith: string[];
  onPick: (hex: string | null) => void;
  onAddCustom: (hex: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <Popover.Content
      aria-label={t('colors.title')}
      // Ao lado do menu, na altura da linha; sem espaço à direita, o Radix abre à esquerda.
      side="right"
      align="start"
      sideOffset={14}
      alignOffset={-12}
      collisionPadding={8}
      className={cx(
        'stroke pop-in z-50 flex w-[15.75rem] flex-col gap-2.5 rounded-[0.625rem] bg-white px-3 pb-3 pt-2.5 shadow-[0_0.5rem_1.5rem_#0F172A1F] outline-none',
      )}
    >
      <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.5px] text-faint">{t('colors.title')}</span>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={t('colors.none')}
          title={t('colors.none')}
          aria-pressed={!value}
          onClick={() => onPick(null)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-faint hover:text-ink-2"
        >
          <Ban size={rem(20)} />
        </button>
        {PALETTE.map((color) => (
          <Swatch key={color.id} hex={color.hex} label={t(`colors.names.${color.id}`)} selected={value === color.hex} onPick={() => onPick(color.hex)} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          aria-label={t('colors.custom')}
          title={t('colors.custom')}
          aria-expanded={editing}
          onClick={() => setEditing(!editing)}
          className={cx(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] bg-white',
            editing ? 'border-[#6366F1] text-ink' : 'border-[#CBD5E1] text-mute hover:border-[#94A3B8] hover:text-ink',
          )}
        >
          <Plus size={rem(12)} />
        </button>
        {customColors.map((hex) => (
          <Swatch key={hex} hex={hex} label={hex} selected={value === hex} onPick={() => onPick(hex)} />
        ))}
      </div>
      {sharedWith.length > 0 && !editing && (
        <p className="text-[0.71875rem] text-mute">
          {t('colors.alsoIn', { repositories: new Intl.ListFormat(localeTag(), { type: 'conjunction' }).format(sharedWith) })}
        </p>
      )}
      {editing && (
        <CustomColorEditor
          initial={value ?? '#1E3A8A'}
          onCancel={() => setEditing(false)}
          onAdd={(hex) => {
            onAddCustom(hex);
            setEditing(false);
          }}
        />
      )}
    </Popover.Content>
  );
}

// Filtro de repositório do board. Dá para marcar vários repositórios (nenhum marcado é "todos"), e cada um tem um
// "…" que abre o seletor de cor: a cor escolhida vira a borda dos cards daquele repositório. Os dois painéis são
// popovers do Radix, que cuida de posição, foco e de fechar com Esc ou clique fora.
export function RepositoryFilter({
  label,
  allLabel,
  countLabel,
  repositories,
  value,
  onChange,
  colors,
  onColorChange,
  customColors,
  onCustomColorsChange,
}: {
  label: string;
  allLabel: string;
  // Texto do botão com mais de um repositório marcado.
  countLabel: (count: number) => string;
  repositories: { id: string; name: string }[];
  // Ids marcados; vazio é "todos".
  value: string[];
  onChange: (value: string[]) => void;
  // Cor de cada repositório, por id.
  colors: Record<string, string>;
  onColorChange: (repositoryId: string, hex: string | null) => void;
  customColors: string[];
  onCustomColorsChange: (colors: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // Repositório com o seletor de cor aberto.
  const [coloring, setColoring] = useState<string | null>(null);
  const chosen = repositories.filter((repository) => value.includes(repository.id));
  const summary = chosen.length === 0 ? allLabel : chosen.length === 1 ? chosen[0]!.name : countLabel(chosen.length);
  // A bolinha do botão mostra a cor quando ela é uma só entre os marcados; fora isso fica vazada. Ela está sempre
  // lá, para o botão não mudar de largura conforme a seleção.
  const chosenColors = new Set(chosen.map((repository) => colors[repository.id]));
  const summaryColor = chosenColors.size === 1 ? [...chosenColors][0] : undefined;
  // Marcar e desmarcar mantém o painel aberto, para escolher vários de uma vez.
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((other) => other !== id) : [...value, id]);
  const ROW = 'rounded-md outline-none hover:bg-[var(--color-hover)] focus-visible:bg-[var(--color-hover)]';

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setColoring(null);
      }}
    >
      <Popover.Trigger className="group stroke hover-surface flex items-center gap-1.5 rounded-lg bg-white px-2.5 py-[0.4375rem] data-[state=open]:stroke-focus">
        <FolderGit2 size={rem(14)} className="text-mute" />
        <span className="text-[0.8125rem] text-mute">{label}:</span>
        <RepoDot color={summaryColor} />
        <span className="max-w-[8.75rem] truncate text-[0.8125rem] font-medium text-ink">{summary}</span>
        <ChevronDown size={rem(14)} className="text-faint transition-transform group-data-[state=open]:rotate-180" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={8}
          collisionPadding={8}
          onScroll={() => setColoring(null)}
          className={cx(
            'stroke pop-in z-40 flex max-h-[min(20rem,var(--radix-popover-content-available-height))] w-[15rem] flex-col gap-0.5 overflow-y-auto rounded-[0.625rem] bg-white p-1.5 shadow-[0_0.5rem_1.5rem_#0F172A1F] outline-none',
          )}
        >
          <button
            type="button"
            role="checkbox"
            aria-checked={chosen.length === 0}
            onClick={() => {
              onChange([]);
              setOpen(false);
            }}
            className={cx(ROW, 'flex items-center gap-2.5 px-2.5 py-2 text-left text-[0.8125rem] font-medium text-ink', chosen.length === 0 && 'bg-soft')}
          >
            <span className="min-w-0 flex-1 truncate">{allLabel}</span>
            {chosen.length === 0 && <Check size={rem(14)} className="shrink-0 text-ink-2" />}
          </button>
          {repositories.map((repository) => {
            const selected = value.includes(repository.id);
            const picking = coloring === repository.id;
            const color = colors[repository.id];
            return (
              <div
                key={repository.id}
                className={cx('flex items-center gap-2.5 rounded-md py-1.5 pl-2.5 pr-1.5 hover:bg-[var(--color-hover)]', (selected || picking) && 'bg-soft')}
              >
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  onClick={() => toggle(repository.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded text-left outline-none focus-visible:stroke-focus"
                >
                  <RepoDot color={color} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.78125rem] font-medium text-ink" title={repository.name}>
                    {repository.name}
                  </span>
                  {selected && <Check size={rem(14)} className="shrink-0 text-ink-2" />}
                </button>
                <Popover.Root open={picking} onOpenChange={(next) => setColoring(next ? repository.id : null)}>
                  <Popover.Trigger
                    aria-label={t('colors.choose', { repository: repository.name })}
                    title={t('colors.title')}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[0.3125rem] text-faint outline-none hover:bg-[#E2E8F0] hover:text-ink focus-visible:stroke-focus data-[state=open]:bg-[#E2E8F0] data-[state=open]:text-ink"
                  >
                    <Ellipsis size={rem(14)} />
                  </Popover.Trigger>
                  <Popover.Portal>
                    <ColorPicker
                      value={color}
                      customColors={customColors}
                      sharedWith={color ? repositories.filter((other) => other.id !== repository.id && colors[other.id] === color).map((other) => other.name) : []}
                      onPick={(hex) => onColorChange(repository.id, hex)}
                      onAddCustom={(hex) => {
                        // A cor nova entra na seleção rápida e já vale para o repositório.
                        if (!PALETTE.some((preset) => preset.hex === hex) && !customColors.includes(hex)) {
                          onCustomColorsChange([...customColors, hex].slice(-MAX_CUSTOM_COLORS));
                        }
                        onColorChange(repository.id, hex);
                      }}
                    />
                  </Popover.Portal>
                </Popover.Root>
              </div>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// Bolinha com a cor do repositório; vazada quando ele não tem cor.
function RepoDot({ color }: { color: string | undefined }) {
  return (
    <span
      aria-hidden
      className={cx('h-2 w-2 shrink-0 rounded-full', !color && 'border-[1.5px] border-[#CBD5E1] bg-white')}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}
