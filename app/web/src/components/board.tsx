import {
  CheckCheck,
  CircleCheck,
  Clock3,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  Layers,
  MessageSquare,
  UserCheck,
  Users,
  UserX,
  type LucideIcon,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { BoardColumnId, PullRequestCard } from '../lib/api';
import { age, authorLabel } from '../lib/format';
import { oldestWaiting, WAITING_COLUMNS, waitingBand, waitingLabel, type WaitingBand } from '../lib/waiting';
import { cardKey } from '../lib/newPrs';
import { Avatar, cx, Dot, SkeletonCard } from './ui';
import { t } from '../lib/i18n';
import { rem } from '../lib/units';

export type ColumnId = 'dependsOnMe' | 'review' | 'conflict' | 'ready' | 'merged' | 'release';

// Nome e descrição vêm do catálogo na hora da leitura, no idioma atual.
const column = (id: ColumnId, color: string) => ({
  id,
  color,
  get name() {
    return t(`columns.${id}.name`);
  },
  get description() {
    return t(`columns.${id}.description`);
  },
});

export const COLUMNS = [
  column('dependsOnMe', '#F59E0B'),
  column('review', '#3B82F6'),
  column('conflict', '#EF4444'),
  column('ready', '#22C55E'),
  column('merged', '#14B8A6'),
  column('release', '#8B5CF6'),
];

// Cores do relógio por faixa de espera: neutro, âmbar e vermelho.
const BAND_TONE: Record<WaitingBand, { chip: string; icon: string; text: string }> = {
  fresh: { chip: 'bg-[#F1F5F9]', icon: 'text-mute', text: 'text-ink-2' },
  attention: { chip: 'bg-[#FEF3C7]', icon: 'text-[#B45309]', text: 'text-[#92400E]' },
  stale: { chip: 'bg-[#FEE2E2]', icon: 'text-[#DC2626]', text: 'text-[#991B1B]' },
};

// "Aguardando você há 3d": há quanto tempo o PR espera por alguém, na cor da faixa.
function WaitingBadge({ pr, column, now }: { pr: PullRequestCard; column: BoardColumnId; now: number }) {
  const tone = BAND_TONE[waitingBand(pr.waitingSince, now)];
  const hint = pr.reason === 'reviewer' ? t('card.reviewer') : pr.reason === 'waiting-author' ? t('card.waitingAuthor') : undefined;
  return (
    <span className={cx('flex items-center gap-1.5 self-start rounded px-2 py-1', tone.chip)} title={hint}>
      <Clock3 size={rem(12)} className={tone.icon} />
      <span className={cx('text-xs font-medium', tone.text)}>{t(waitingLabel(pr, column), { age: age(pr.waitingSince, now) })}</span>
    </span>
  );
}

// Maior espera da coluna, no cabeçalho ("máx. 4d").
export function WaitingMax({ cards, now }: { cards: PullRequestCard[]; now: number }) {
  const since = oldestWaiting(cards);
  if (!since) return null;
  return (
    <span className={cx('flex items-center gap-1 text-xs font-semibold', BAND_TONE[waitingBand(since, now)].icon)} title={t('waiting.maxHint')}>
      <Clock3 size={rem(12)} />
      {t('waiting.max', { age: age(since, now) })}
    </span>
  );
}

// `color` é a cor que o usuário deu ao repositório: vira a borda do card, para reconhecer de longe de onde é o PR.
// `column` é onde o card está: nas colunas de espera, o card mostra há quanto tempo o PR aguarda alguém.
// `fresh`: o PR acabou de chegar em "Depende de mim" (badge Novo e um halo, até o próximo sync ou até ser aberto).
export function PrCard({
  pr,
  now,
  color,
  column,
  fresh,
  onOpen,
}: {
  pr: PullRequestCard;
  now: number;
  color?: string;
  column: BoardColumnId;
  fresh?: boolean;
  onOpen?: () => void;
}) {
  return (
    <a
      href={pr.webUrl}
      target="_blank"
      rel="noreferrer"
      data-fresh={fresh || undefined}
      onClick={onOpen}
      // Clique do meio também abre o PR, numa aba nova.
      onAuxClick={(event) => event.button === 1 && onOpen?.()}
      className={cx(
        'stroke fade-up flex flex-col gap-2.5 rounded-lg bg-white p-3.5 hover:shadow-[0_0.375rem_1rem_#0F172A1A]',
        !color && 'hover:[--stroke:#94A3B8]',
        fresh && 'shadow-[0_0_0_0.1875rem_#FDE68A] hover:shadow-[0_0_0_0.1875rem_#FDE68A,0_0.375rem_1rem_#0F172A1A]',
        fresh && !color && '[--stroke:#F59E0B]',
      )}
      style={color ? ({ '--stroke': color, outlineWidth: 1.5, outlineOffset: -0.75 } as CSSProperties) : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <GitPullRequest size={rem(13)} className="shrink-0 text-faint" />
          <span className="truncate font-mono text-[0.71875rem] text-mute">{pr.repository.name}</span>
          <span className="font-mono text-[0.71875rem] text-faint">#{pr.id}</span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          {fresh && (
            <span className="rounded bg-[#F59E0B] px-1.5 py-px text-[0.6875rem] font-semibold text-white">{t('newPrs.badge')}</span>
          )}
          <span className="text-xs text-faint">{age(pr.createdAt, now)}</span>
        </span>
      </div>

      {pr.project && (
        <span className="-mb-1 flex max-w-full items-center gap-1 self-start rounded bg-[#EEF2FF] px-1.5 py-0.5" title={t('card.project')}>
          <Layers size={rem(11)} className="shrink-0 text-[#4F46E5]" />
          <span className="truncate text-[0.6875rem] font-medium text-[#3730A3]">{pr.project.name}</span>
        </span>
      )}

      <p className="text-sm font-semibold leading-[1.35] text-ink">{pr.title}</p>

      {WAITING_COLUMNS.includes(column) && <WaitingBadge pr={pr} column={column} now={now} />}

      <div className="flex items-center gap-1.5">
        <GitMerge size={rem(13)} className="shrink-0 text-faint" />
        <span className="text-xs text-mute">{t('card.into')}</span>
        <span className="truncate rounded bg-[#F1F5F9] px-1.5 py-0.5 font-mono text-[0.71875rem] font-medium text-ink-2">
          {pr.targetBranch}
        </span>
      </div>

      <div className="h-px bg-line-soft" />

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Avatar name={pr.author.name} isMe={pr.author.isMe} avatarKey={pr.author.avatarKey} />
          <span className="truncate text-xs text-ink-2">{authorLabel(pr.author)}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {pr.commentCount > 0 && (
            <span className="flex items-center gap-1" title={t('card.comments')}>
              <MessageSquare size={rem(13)} className="text-mute" />
              <span className="text-xs font-medium text-mute">{pr.commentCount}</span>
            </span>
          )}
          {pr.conflictCount > 0 && (
            <span className="flex items-center gap-1" title={t('card.conflicts')}>
              <GitCompareArrows size={rem(13)} className="text-[#DC2626]" />
              <span className="text-xs font-medium text-[#DC2626]">{pr.conflictCount}</span>
            </span>
          )}
          {pr.noReviewers ? (
            // Caso raro: sem ninguém para votar, a contagem não diz nada e dá lugar ao aviso.
            <span className="flex items-center gap-1" title={t('card.noReviewerHint')}>
              <UserX size={rem(13)} className="text-[#B45309]" />
              <span className="whitespace-nowrap text-xs font-medium text-[#B45309]">{t('card.noReviewer')}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1" title={t('card.approvals')}>
              <CircleCheck size={rem(13)} className={pr.approved ? 'text-[#16A34A]' : 'text-faint'} />
              <span className={cx('text-xs font-medium', pr.approved ? 'text-[#16A34A]' : 'text-mute')}>
                {pr.approvals}/{pr.reviewers}
              </span>
            </span>
          )}
        </div>
      </div>
    </a>
  );
}

// Respiro mínimo entre a coluna e o fim da área do board.
const BOTTOM_MARGIN = 8;

// A coluna só rola quando, inteira, passaria do fim da tela. Enquanto couber, ela cresce à vontade,
// inclusive sobre a folga de baixo do board; só quando não cabe é que ganha altura máxima e barra.
function useColumnScroll() {
  const sectionRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    const board = section?.closest('main') ?? section?.parentElement;
    if (!section || !scroll || !content || !board) return;

    const measure = () => {
      const paddingTop = parseFloat(getComputedStyle(board).paddingTop);
      // clientHeight já desconta a barra horizontal do board, quando existe.
      const available = board.clientHeight - paddingTop - BOTTOM_MARGIN;
      // Altura que a coluna teria sem limite: a atual mais o que estiver escondido na rolagem.
      const natural = section.offsetHeight + (scroll.scrollHeight - scroll.clientHeight);
      setScrolls(natural > available);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    observer.observe(content);
    measure();
    return () => observer.disconnect();
  }, []);

  return { sectionRef, scrollRef, contentRef, scrolls };
}

export function ColumnShell({
  id,
  count,
  highlight,
  headerAction,
  top,
  footer,
  children,
}: {
  id: ColumnId;
  count?: number;
  // Cor do traço de 2px que destaca a coluna durante e depois de criar a release.
  highlight?: string;
  headerAction?: ReactNode;
  // Ficam fora da área de rolagem: acima (seletores, cujos menus não podem ser cortados) e abaixo dela.
  top?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const column = COLUMNS.find((c) => c.id === id)!;
  const { sectionRef, scrollRef, contentRef, scrolls } = useColumnScroll();
  const tone =
    id === 'dependsOnMe'
      ? 'bg-[#FFF8EB] [--stroke:#FAD9A1]'
      : id === 'release'
        ? 'bg-[#F5F3FF] [--stroke:#DDD6FE]'
        : 'bg-lane [--stroke:#F1F3F6]';
  return (
    <section
      ref={sectionRef}
      aria-label={column.name}
      className={cx(
        'flex min-w-[14.0625rem] flex-1 basis-0 flex-col gap-2.5 self-start rounded-xl p-2.5',
        scrolls && 'max-h-full',
        tone,
        highlight ? 'stroke-2' : 'stroke',
      )}
      style={highlight ? ({ '--stroke': highlight } as React.CSSProperties) : undefined}
    >
      <header className="flex flex-col gap-1 px-1.5 pb-2 pt-1.5">
        <div className="flex items-center gap-2">
          <Dot color={column.color} />
          <h2 className="text-sm font-bold text-ink">{column.name}</h2>
          {count !== undefined && (
            <span className="stroke rounded-[0.625rem] bg-white px-[0.4375rem] py-px text-xs font-semibold text-ink-2">{count}</span>
          )}
          {headerAction && <span className="ml-auto flex">{headerAction}</span>}
        </div>
        <p className={cx('text-xs text-mute', id === 'merged' && 'leading-[1.4]')}>{column.description}</p>
      </header>
      {top}
      {/* A margem negativa leva a barra até a borda da coluna e não corta o contorno dos cards. */}
      <div
        ref={scrollRef}
        className={cx('-mx-2.5 -my-0.5 min-h-0 px-2.5 py-0.5', scrolls && 'column-scroll overflow-y-auto')}
      >
        <div ref={contentRef} className="flex flex-col gap-2.5">
          {children}
        </div>
      </div>
      {footer}
    </section>
  );
}

// Esconder e revelar coluna: o slot encolhe (ou cresce) na largura com fade, como as plataformas da tela de entrada
// abrem e fecham. Colunas ocultas continuam montadas, com largura zero e a margem negativa anulando o espaço entre
// colunas. A animação fica em useColumnSlots.
export function ColumnSlot({ shown, children }: { shown: boolean; children: ReactNode }) {
  return (
    <div
      data-column-slot
      inert={!shown}
      aria-hidden={!shown}
      className={cx(
        // O recorte deixa 4px de folga para o contorno de 2px das colunas destacadas não ser cortado.
        'flex self-stretch overflow-x-clip [overflow-clip-margin:0.25rem]',
        shown ? 'min-w-[14.0625rem] flex-1 basis-0' : 'pointer-events-none -ml-4 w-0 min-w-0 grow-0 basis-0 opacity-0',
      )}
    >
      {children}
    </div>
  );
}

type SlotBox = { width: number; margin: number; opacity: number };

const slotBoxes = (board: HTMLElement | null) =>
  [...(board?.querySelectorAll<HTMLElement>(':scope > [data-column-slot]') ?? [])].map((slot) => {
    const style = getComputedStyle(slot);
    return { width: slot.offsetWidth, margin: parseFloat(style.marginLeft), opacity: parseFloat(style.opacity) };
  });

// Anima os slots da posição antiga para a nova quando o conjunto de colunas visíveis muda (`visible` identifica esse
// conjunto). Animar a largura das colunas direto faria o board recalcular o layout de todos os cards a cada quadro e a
// animação perderia quadros; por isso o conteúdo de cada coluna fica com largura fixa (a maior entre a antiga e a
// nova) enquanto só o slot em volta muda de largura e recorta. O layout por quadro fica trivial.
// A animação em curso de cada slot. Quando outra começa por cima, só a mais nova pode soltar o conteúdo.
const slotAnimations = new WeakMap<HTMLElement, Animation>();

export function useColumnSlots(board: React.RefObject<HTMLElement | null>, visible: string) {
  const previous = useRef<{ visible: string; boxes: SlotBox[] }>({ visible, boxes: [] });
  // Mede antes do commit, ainda com o DOM antigo.
  if (previous.current.visible !== visible) previous.current = { visible, boxes: slotBoxes(board.current) };

  useLayoutEffect(() => {
    const before = previous.current.boxes;
    previous.current.boxes = [];
    if (!before.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const slots = [...(board.current?.querySelectorAll<HTMLElement>(':scope > [data-column-slot]') ?? [])];
    const after = slotBoxes(board.current);
    const running = slots.flatMap((slot, i) => {
      const from = before[i];
      const to = after[i];
      if (!from || !to || (from.width === to.width && from.margin === to.margin)) return [];
      const content = slot.firstElementChild as HTMLElement | null;
      if (content) {
        content.style.flex = 'none';
        // Escondendo, vale a largura de antes; revelando, a de depois. Nenhuma das duas fica abaixo da mínima da coluna.
        content.style.width = `${Math.max(from.width, to.width)}px`;
      }
      const frame = (box: SlotBox) => ({
        flexGrow: 0,
        flexBasis: `${box.width}px`,
        width: `${box.width}px`,
        minWidth: 0,
        marginLeft: `${box.margin}px`,
        opacity: box.opacity,
      });
      const animation = slot.animate([frame(from), frame(to)], { duration: 220, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
      slotAnimations.set(slot, animation);
      const release = () => {
        if (slotAnimations.get(slot) !== animation) return;
        slotAnimations.delete(slot);
        content?.style.removeProperty('flex');
        content?.style.removeProperty('width');
      };
      // Cancelada (outra troca de colunas chegou antes do fim) ou concluída, o conteúdo volta à largura normal.
      animation.finished.then(release, release);
      return [{ animation, release }];
    });
    // Solta na hora, antes de a próxima troca medir as colunas.
    return () =>
      running.forEach(({ animation, release }) => {
        release();
        animation.cancel();
      });
  }, [board, visible]);
}

export function EmptyState() {
  return (
    <div className="stroke fade-up flex flex-col items-center gap-2.5 rounded-lg bg-white px-5 py-8">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-[#DCFCE7]">
        <CheckCheck size={rem(20)} className="text-[#16A34A]" />
      </span>
      <p className="text-sm font-semibold text-ink">{t('board.nothingOnYou')}</p>
      <p className="text-center text-[0.78125rem] leading-[1.45] text-mute">
        {t('board.allCaughtUp')}
      </p>
    </div>
  );
}

export type ReviewerScope = 'all' | 'required';

// Na coluna "Depende de mim": todos os PRs em que sou revisor, ou só aqueles em que meu voto é obrigatório.
export function ReviewerScopeToggle({ value, onChange }: { value: ReviewerScope; onChange: (value: ReviewerScope) => void }) {
  const options: { id: ReviewerScope; label: string; icon: LucideIcon }[] = [
    { id: 'all', label: t('board.reviewerAll'), icon: Users },
    { id: 'required', label: t('board.reviewerRequired'), icon: UserCheck },
  ];
  return (
    <div className="flex items-center justify-between gap-2 px-1.5">
      <span className="text-xs text-mute">{t('board.asReviewer')}</span>
      <div role="radiogroup" aria-label={t('board.reviewerGroup')} className="flex gap-0.5 rounded-lg bg-[#FDEFD3] p-[0.1875rem]">
        {options.map((option) => {
          const selected = option.id === value;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={option.label}
              title={option.label}
              onClick={() => onChange(option.id)}
              className={cx(
                'flex h-6 w-7 items-center justify-center rounded-md',
                selected ? 'bg-white text-ink shadow-[0_1px_2px_#0F172A14]' : 'text-[#92400E] hover:text-ink',
              )}
            >
              <option.icon size={rem(14)} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// No lugar de Mergeados e Release, com todos os projetos: as duas colunas dependem de um repositório.
export function PerRepositoryPlaceholder({ onChooseProject }: { onChooseProject: () => void }) {
  return (
    <section
      aria-label={t('board.perRepositoryTitle')}
      className="stroke flex min-w-[14.0625rem] flex-[2] basis-0 flex-col items-center gap-3 self-start rounded-xl border-dashed bg-lane px-6 py-10 text-center [--stroke:#E2E8F0]"
    >
      <span className="flex gap-1.5">
        <Dot color={COLUMNS.find((c) => c.id === 'merged')!.color} />
        <Dot color={COLUMNS.find((c) => c.id === 'release')!.color} />
      </span>
      <p className="text-sm font-semibold text-ink">{t('board.perRepositoryTitle')}</p>
      <p className="max-w-[22rem] text-[0.78125rem] leading-[1.45] text-mute">{t('board.perRepositoryBody')}</p>
      <button
        type="button"
        onClick={onChooseProject}
        className="stroke hover-surface rounded-lg bg-white px-3 py-[0.4375rem] text-[0.8125rem] font-medium text-ink"
      >
        {t('board.chooseProject')}
      </button>
    </section>
  );
}

export function QuietNote({ children }: { children: ReactNode }) {
  return <p className="px-1.5 pb-1 text-xs text-faint">{children}</p>;
}

export function OpenColumn({
  id,
  cards,
  loading,
  emptyState,
  filtered,
  now,
  controls,
  headerAction,
  repositoryColors,
  fresh,
  onOpen,
  emptyNote = t('board.noneFiltered'),
}: {
  id: Exclude<ColumnId, 'merged' | 'release'>;
  cards: PullRequestCard[];
  loading: boolean;
  // Só o board completo e sem filtros pode afirmar que nada depende do usuário.
  emptyState: boolean;
  filtered: boolean;
  now: number;
  // Controles próprios da coluna, logo abaixo do cabeçalho.
  controls?: ReactNode;
  headerAction?: ReactNode;
  // Cor que o usuário deu a cada repositório, por id.
  repositoryColors?: Record<string, string>;
  // PRs que acabaram de chegar (por `cardKey`) e o aviso de que um deles foi aberto.
  fresh?: ReadonlySet<string>;
  onOpen?: (key: string) => void;
  emptyNote?: string;
}) {
  if (loading) {
    return (
      <ColumnShell id={id}>
        {Array.from({ length: id === 'dependsOnMe' ? 3 : 2 }, (_, i) => (
          <SkeletonCard key={i} />
        ))}
      </ColumnShell>
    );
  }
  return (
    <ColumnShell id={id} count={cards.length} top={controls} headerAction={headerAction}>
      {cards.map((pr) => (
        <PrCard
          key={cardKey(pr)}
          pr={pr}
          now={now}
          color={repositoryColors?.[pr.repository.id]}
          column={id}
          fresh={fresh?.has(cardKey(pr))}
          onOpen={onOpen && (() => onOpen(cardKey(pr)))}
        />
      ))}
      {cards.length === 0 && id === 'dependsOnMe' && emptyState && <EmptyState />}
      {cards.length === 0 && filtered && <QuietNote>{emptyNote}</QuietNote>}
    </ColumnShell>
  );
}
