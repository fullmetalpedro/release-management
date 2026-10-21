import { Copy, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useMemo, useRef, useState } from 'react';
import type { ReleaseDetails } from '../lib/api';
import { t } from '../lib/i18n';
import { buildReleaseNotes, parseMarkdown, toPlainText, type Inline, type ReleaseNotesLabels } from '../lib/releaseNotes';
import { rem } from '../lib/units';
import { useToast } from './toast';
import { Checkbox, cx } from './ui';

type Tab = 'preview' | 'markdown' | 'text';
const TABS: Tab[] = ['preview', 'markdown', 'text'];

function InlineContent({ content }: { content: Inline[] }) {
  return content.map((part, index) =>
    part.kind === 'link' ? (
      <a key={index} href={part.url} target="_blank" rel="noreferrer" className="text-[#4F46E5] hover:underline">
        {part.text}
      </a>
    ) : (
      <span key={index}>{part.text}</span>
    ),
  );
}

// A aba Visualização: o markdown gerado, com títulos, listas e links clicáveis.
function MarkdownPreview({ markdown }: { markdown: string }) {
  const blocks = useMemo(() => parseMarkdown(markdown), [markdown]);
  return (
    <div className="flex flex-col gap-3 text-[0.8125rem] leading-[1.55] text-ink">
      {blocks.map((block, index) => {
        if (block.kind === 'list') {
          return (
            <ul key={index} className="flex list-disc flex-col gap-1 pl-5 marker:text-faint">
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  <InlineContent content={item} />
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'heading') {
          const Tag = block.level === 1 ? 'h3' : 'h4';
          return (
            <Tag
              key={index}
              className={cx('font-semibold', block.level === 1 ? 'font-mono text-base' : 'pt-1 text-sm')}
            >
              <InlineContent content={block.content} />
            </Tag>
          );
        }
        return (
          <p key={index} className="text-mute">
            <InlineContent content={block.content} />
          </p>
        );
      })}
    </div>
  );
}

// A Clipboard API só existe em contexto seguro: servido por http num endereço da rede (o Docker), cai no
// execCommand. O campo temporário fica dentro do modal, senão o foco preso pelo Radix impede a seleção.
async function copyToClipboard(text: string, container: HTMLElement | null) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  (container ?? document.body).append(field);
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  if (!copied) throw new Error(t('notes.copyUnavailable'));
}

function Option({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <div className="flex cursor-pointer select-none items-center gap-2" onClick={onChange}>
      <Checkbox state={checked ? 'on' : 'off'} onChange={onChange} label={label} />
      <span className="text-[0.8125rem] text-ink-2">{label}</span>
    </div>
  );
}

// Modal "Copiar notas" da release: gera as notas a partir do que a tela já carregou, sem request novo.
export function ReleaseNotesDialog({
  details,
  jira,
  open,
  onOpenChange,
}: {
  details: ReleaseDetails;
  jira: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('preview');
  const [groupByType, setGroupByType] = useState(true);
  const [includeLinks, setIncludeLinks] = useState(true);
  const [includeUnlinked, setIncludeUnlinked] = useState(true);

  const labels: ReleaseNotesLabels = {
    types: {
      features: t('notes.features'),
      fixes: t('notes.fixes'),
      maintenance: t('notes.maintenance'),
      others: t('notes.others'),
    },
    unlinked: t('notes.unlinked'),
    empty: t('notes.empty'),
  };
  const markdown = buildReleaseNotes(details, { groupByType, includeLinks, includeUnlinked, labels });
  const plain = useMemo(() => toPlainText(markdown), [markdown]);
  const copiesText = tab === 'text';
  const contentRef = useRef<HTMLDivElement>(null);

  const copy = async () => {
    try {
      await copyToClipboard(copiesText ? plain : markdown, contentRef.current);
      toast.show({ kind: 'success', title: copiesText ? t('notes.copiedText') : t('notes.copiedMarkdown') });
    } catch (error) {
      toast.show({ kind: 'error', title: t('notes.copyFailed'), description: error instanceof Error ? error.message : undefined });
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-[#0F172A66]" />
        <Dialog.Content
          ref={contentRef}
          aria-describedby={undefined}
          className="stroke pop-in fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-4rem)] w-[45rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl bg-white p-6 shadow-[0_1.5rem_3rem_#0F172A40] outline-none"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-base font-semibold text-ink">{t('notes.title')}</Dialog.Title>
              <p className="font-mono text-xs text-mute">{details.release?.name}</p>
            </div>
            <Dialog.Close aria-label={t('common.close')} className="rounded-md p-1 text-mute hover-surface">
              <X size={rem(16)} />
            </Dialog.Close>
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Option checked={groupByType} onChange={() => setGroupByType(!groupByType)} label={t('notes.groupByType')} />
            <Option checked={includeLinks} onChange={() => setIncludeLinks(!includeLinks)} label={t('notes.includeLinks')} />
            <Option
              checked={includeUnlinked}
              onChange={() => setIncludeUnlinked(!includeUnlinked)}
              label={jira ? t('notes.includeUnlinkedJira') : t('notes.includeUnlinked')}
            />
          </div>

          <div role="tablist" aria-label={t('notes.formats')} className="flex gap-[0.1875rem] self-start rounded-[0.625rem] bg-[#EEF0F3] p-[0.1875rem]">
            {TABS.map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={id === tab}
                onClick={() => setTab(id)}
                className={cx(
                  'h-7 rounded-lg px-3 text-[0.78125rem]',
                  id === tab ? 'bg-white font-semibold text-ink shadow-[0_1px_0.1875rem_#0F172A14]' : 'font-medium text-mute hover:text-ink',
                )}
              >
                {t(`notes.tab.${id}`)}
              </button>
            ))}
          </div>

          <div role="tabpanel" className="stroke min-h-[12rem] overflow-y-auto rounded-[0.625rem] bg-soft px-5 py-4">
            {tab === 'preview' ? (
              <MarkdownPreview markdown={markdown} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-[1.6] text-ink-2">
                {tab === 'markdown' ? markdown : plain}
              </pre>
            )}
          </div>

          <div className="flex justify-end gap-2.5">
            <Dialog.Close className="stroke rounded-lg bg-white px-3.5 py-2 text-[0.8125rem] font-medium text-ink hover-surface">
              {t('common.close')}
            </Dialog.Close>
            <button
              type="button"
              onClick={() => void copy()}
              className="hover-primary flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-2"
            >
              <Copy size={rem(14)} className="text-white" />
              <span className="text-[0.8125rem] font-semibold text-white">
                {copiesText ? t('notes.copyText') : t('notes.copyMarkdown')}
              </span>
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
