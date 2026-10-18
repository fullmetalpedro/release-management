import type { LanePullRequest, ReleaseDetails, WorkItemSummary } from './api';

// Gerador das notas da release em markdown e o mínimo para mostrá-las: o markdown produzido aqui só tem títulos,
// listas e links, então um conversor próprio basta e a interface não ganha dependência. Tudo puro, sem i18n: os
// textos chegam prontos em `labels`, para o teste rodar fora do navegador.

export type ChangeType = 'features' | 'fixes' | 'maintenance' | 'others';

export interface ReleaseNotesLabels {
  types: Record<ChangeType, string>;
  unlinked: string;
  empty: string;
}

export interface ReleaseNotesOptions {
  groupByType: boolean;
  includeLinks: boolean;
  includeUnlinked: boolean;
  labels: ReleaseNotesLabels;
}

const TYPE_ORDER: ChangeType[] = ['features', 'fixes', 'maintenance', 'others'];
const PREFIXES: Record<string, ChangeType> = {
  feat: 'features',
  feature: 'features',
  fix: 'fixes',
  bugfix: 'fixes',
  hotfix: 'fixes',
  chore: 'maintenance',
  refactor: 'maintenance',
  perf: 'maintenance',
  build: 'maintenance',
  ci: 'maintenance',
  docs: 'maintenance',
  test: 'maintenance',
  style: 'maintenance',
};
// `feat: x`, `fix(api): x`, `feat!: x`.
const CONVENTIONAL = /^\s*([a-z]+)(\([^)]*\))?!?:\s*/i;

export function changeType(title: string): { type: ChangeType; rest: string } {
  const match = CONVENTIONAL.exec(title);
  const type = match && PREFIXES[match[1]!.toLowerCase()];
  return type ? { type, rest: title.slice(match[0].length) || title } : { type: 'others', rest: title };
}

// Escapa o que o conversor abaixo interpretaria, para um título com colchetes ou asteriscos sair como foi escrito.
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\[\]()*_`#<>]/g, '\\$&');
}

// Parênteses e espaços fechariam o link antes da hora; percent-encoded, a URL continua a mesma para o navegador.
const linkUrl = (url: string) =>
  url.replace(/[()\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

function link(text: string, url: string, includeLinks: boolean): string {
  return includeLinks && url ? `[${escapeMarkdown(text)}](${linkUrl(url)})` : escapeMarkdown(text);
}

const itemKey = (item: WorkItemSummary) => item.key ?? `PBI ${item.id}`;

export function buildReleaseNotes(details: ReleaseDetails, options: ReleaseNotesOptions): string {
  const { release } = details;
  if (!release) return '';
  const { includeLinks, labels } = options;
  const prRef = (pr: LanePullRequest) => link(`#${pr.id}`, pr.webUrl, includeLinks);
  const sections: { title: string; lines: string[] }[] = [];

  if (options.groupByType) {
    // Um PR pode estar em mais de um item (vínculos com tasks de PBIs diferentes): aparece uma vez, com todos eles.
    const byId = new Map<number, { pr: LanePullRequest; items: WorkItemSummary[] }>();
    for (const group of details.groups) {
      for (const { pullRequest } of group.rows) {
        const entry = byId.get(pullRequest.id) ?? { pr: pullRequest, items: [] };
        if (!entry.items.some((item) => item.id === group.pbi.id)) entry.items.push(group.pbi);
        byId.set(pullRequest.id, entry);
      }
    }
    if (options.includeUnlinked) {
      for (const pr of details.unlinked) if (!byId.has(pr.id)) byId.set(pr.id, { pr, items: [] });
    }
    const buckets = new Map<ChangeType, string[]>();
    for (const { pr, items } of byId.values()) {
      const { type, rest } = changeType(pr.title);
      const refs = items.map((item) => link(itemKey(item), item.webUrl, includeLinks)).join(', ');
      const line = `- ${prRef(pr)} ${escapeMarkdown(rest)}${refs ? ` (${refs})` : ''}`;
      buckets.set(type, [...(buckets.get(type) ?? []), line]);
    }
    for (const type of TYPE_ORDER) {
      const lines = buckets.get(type);
      if (lines) sections.push({ title: labels.types[type], lines });
    }
  } else {
    for (const group of details.groups) {
      const seen = new Set<number>();
      const lines: string[] = [];
      for (const { pullRequest } of group.rows) {
        if (seen.has(pullRequest.id)) continue;
        seen.add(pullRequest.id);
        lines.push(`- ${prRef(pullRequest)} ${escapeMarkdown(pullRequest.title)}`);
      }
      sections.push({
        title: `${link(itemKey(group.pbi), group.pbi.webUrl, includeLinks)} · ${escapeMarkdown(group.pbi.title)}`,
        lines,
      });
    }
    if (options.includeUnlinked && details.unlinked.length > 0) {
      sections.push({
        title: escapeMarkdown(labels.unlinked),
        lines: details.unlinked.map((pr) => `- ${prRef(pr)} ${escapeMarkdown(pr.title)}`),
      });
    }
  }

  const blocks = [`# ${escapeMarkdown(release.name)}`];
  if (sections.length === 0) blocks.push(escapeMarkdown(labels.empty));
  for (const section of sections) blocks.push(`## ${section.title}\n\n${section.lines.join('\n')}`);
  return `${blocks.join('\n\n')}\n`;
}

// --- Leitura do markdown gerado: blocos e trechos de linha, para a aba Visualização e o texto simples. ---

export type Inline = { kind: 'text'; text: string } | { kind: 'link'; text: string; url: string };
export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3; content: Inline[] }
  | { kind: 'list'; items: Inline[][] }
  | { kind: 'paragraph'; content: Inline[] };

const unescape = (text: string) => text.replace(/\\(.)/g, '$1');

// Só `[texto](url)` e escapes com barra invertida: é tudo o que buildReleaseNotes produz.
export function parseInline(source: string): Inline[] {
  const result: Inline[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = result.at(-1);
    if (last?.kind === 'text') last.text += text;
    else result.push({ kind: 'text', text });
  };
  const pattern = /\\(.)|\[((?:\\.|[^\\\]])*)\]\(([^)\s]+)\)/g;
  let index = 0;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    pushText(source.slice(index, match.index));
    if (match[1] !== undefined) pushText(match[1]);
    else result.push({ kind: 'link', text: unescape(match[2]!), url: match[3]! });
    index = pattern.lastIndex;
  }
  pushText(source.slice(index));
  return result;
}

export function parseMarkdown(markdown: string): Block[] {
  const blocks: Block[] = [];
  for (const line of markdown.split('\n')) {
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length as 1 | 2 | 3, content: parseInline(heading[2]!) });
    } else if (item) {
      const last = blocks.at(-1);
      if (last?.kind === 'list') last.items.push(parseInline(item[1]!));
      else blocks.push({ kind: 'list', items: [parseInline(item[1]!)] });
    } else if (line.trim()) {
      blocks.push({ kind: 'paragraph', content: parseInline(line) });
    }
  }
  return blocks;
}

const inlineText = (content: Inline[]) =>
  content.map((part) => (part.kind === 'link' && part.url !== part.text ? `${part.text} (${part.url})` : part.text)).join('');

// Texto simples: sem marcação, links como "texto (url)", títulos sublinhados e listas com marcador. O sublinhado
// acompanha só o texto do título, sem as URLs, para não virar uma linha que quebra no meio.
export function toPlainText(markdown: string): string {
  const parts = parseMarkdown(markdown).map((block) => {
    if (block.kind === 'list') return block.items.map((item) => `• ${inlineText(item)}`).join('\n');
    const text = inlineText(block.content);
    if (block.kind === 'paragraph') return text;
    const width = block.content.map((part) => part.text).join('').length;
    return `${text}\n${(block.level === 1 ? '=' : '-').repeat(width)}`;
  });
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}
