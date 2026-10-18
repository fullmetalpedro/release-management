import { useEffect, useRef, useState } from 'react';
import type { Board, Me, PullRequestCard } from './api';
import { useStoredState } from './format';

// O número do PR se repete entre repositórios (GitHub) e entre plataformas: a chave junta os três.
export const cardKey = (pr: PullRequestCard) => `${pr.provider}-${pr.repository.id}-${pr.id}`;

// Ids de agora que nunca estiveram na coluna, na ordem em que chegaram.
export function diffNewPrs(current: readonly string[], seen: ReadonlySet<string>): string[] {
  return current.filter((id) => !seen.has(id));
}

// O que já passou por "Depende de mim" nesta sessão do navegador, por fonte + conta + organização + projeto.
// `scope` é o escopo da última sincronização olhada: um escopo diferente é a primeira carga ou uma troca.
export interface SeenMemory {
  scope?: string;
  seen: Map<string, Set<string>>;
}

export const createSeenMemory = (): SeenMemory => ({ seen: new Map() });

// Registra uma sincronização e devolve os ids que merecem aviso. Na primeira carga e depois de trocar de org ou de
// projeto, só anota o que está na coluna. Um id que já esteve nela (e voltou, depois de um push que zerou os votos)
// não avisa de novo.
export function recordSync(memory: SeenMemory, scope: string, ids: readonly string[]): string[] {
  const seen = memory.seen.get(scope) ?? new Set<string>();
  memory.seen.set(scope, seen);
  const baseline = memory.scope !== scope;
  memory.scope = scope;
  const fresh = baseline ? [] : diffNewPrs(ids, seen);
  for (const id of ids) seen.add(id);
  return fresh;
}

// Em memória: recarregar a página começa do zero, e a primeira carga não avisa.
const memory = createSeenMemory();

export function sourceScope(me: Me, projectId: string) {
  const account = me.accounts.find((a) => a.provider === me.source?.provider && a.active !== false);
  return [me.source?.provider ?? '', account?.account ?? account?.handle ?? '', me.organization, projectId].join('|');
}

export type NotifyPermission = NotificationPermission | 'unsupported';

const notificationPermission = (): NotifyPermission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

// O checkbox "Avisar quando chegar PR que depende de mim" no menu de sincronização. Ligar pede a permissão do
// navegador; com a permissão negada, o aviso do navegador não sai mesmo com o checkbox ligado.
export function useNewPrNotifications() {
  const [optIn, setOptIn] = useStoredState<boolean>('rm.newPrNotify', false, (v): v is boolean => typeof v === 'boolean');
  const [permission, setPermission] = useState<NotifyPermission>(notificationPermission);
  const toggle = async (next: boolean) => {
    if (!next || permission === 'unsupported') return setOptIn(false);
    const granted = permission === 'granted' ? permission : await Notification.requestPermission();
    setPermission(granted);
    setOptIn(granted === 'granted');
  };
  return { enabled: optIn && permission === 'granted', permission, toggle };
}

// O aviso do navegador é para quem não está olhando: aba escondida ou janela atrás de outra.
const inBackground = () => document.visibilityState === 'hidden' || !document.hasFocus();

const BASE_TITLE = 'Release Management';

// Compara a coluna "Depende de mim" a cada sincronização do board. Devolve os PRs que acabaram de chegar (o badge
// Novo vale até o próximo sync ou até o PR ser aberto) e cuida do título da aba enquanto o board está aberto.
export function useNewPrs({
  me,
  projectId,
  board,
  updatedAt,
  counts,
  waiting,
  notify,
  onNew,
}: {
  me: Me;
  projectId: string | undefined;
  board: Board | undefined;
  // Quando esta aba recebeu o dado: muda a cada sincronização, mesmo que nada tenha mudado.
  updatedAt: number;
  // Se o PR conta para o aviso (o filtro "Só obrigatório" esconde os PRs em que sou revisor opcional).
  counts: (pr: PullRequestCard) => boolean;
  // Quantos dependem de mim, para o título da aba.
  waiting: number;
  notify: boolean;
  onNew: (prs: PullRequestCard[], notifyBrowser: boolean) => void;
}) {
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const latest = useRef({ counts, notify, onNew });
  latest.current = { counts, notify, onNew };

  useEffect(() => {
    // Sem dado (projeto ou org trocados, cache limpo): o próximo board é uma primeira carga.
    if (!board || !projectId) {
      memory.scope = undefined;
      setFresh(new Set());
      return;
    }
    const column = board.columns.dependsOnMe;
    const ids = recordSync(memory, sourceScope(me, projectId), column.map(cardKey));
    const prs = column.filter((pr) => ids.includes(cardKey(pr)) && latest.current.counts(pr));
    setFresh(new Set(prs.map(cardKey)));
    if (prs.length > 0) latest.current.onNew(prs, latest.current.notify && inBackground());
    // `board` muda junto com `updatedAt`; o escopo vem de `me` e do projeto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updatedAt, board, projectId, me.source?.provider, me.organization]);

  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) ${BASE_TITLE}` : BASE_TITLE;
  }, [waiting]);
  // Fora do board o título volta ao normal.
  useEffect(() => () => void (document.title = BASE_TITLE), []);

  const opened = (key: string) =>
    setFresh((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  return { fresh, opened };
}

// Aviso do sistema com os PRs novos; clicar traz a aba de volta.
export function showBrowserNotification(title: string, body: string, onClick: () => void) {
  if (notificationPermission() !== 'granted') return;
  const notification = new Notification(title, { body, tag: 'rm-new-prs', icon: '/favicon.svg' });
  notification.onclick = () => {
    window.focus();
    notification.close();
    onClick();
  };
}
