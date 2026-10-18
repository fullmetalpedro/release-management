import { useStoredState } from './format';

// Opções do menu "Atualizar automaticamente", em minutos; 0 é desligado.
export const SYNC_INTERVALS = [0, 2, 5, 10, 15] as const;
export type SyncInterval = (typeof SYNC_INTERVALS)[number];
export const DEFAULT_SYNC_INTERVAL: SyncInterval = 5;

const isSyncInterval = (value: unknown): value is SyncInterval => SYNC_INTERVALS.includes(value as SyncInterval);

// Board, raias, release e lista de projetos se refazem sozinhos no intervalo escolhido pelo usuário.
export function useSyncInterval() {
  return useStoredState<SyncInterval>('rm.syncInterval', DEFAULT_SYNC_INTERVAL, isSyncInterval);
}

// Opções das consultas que se refazem sozinhas. Com a aba em segundo plano o TanStack não busca nada
// (refetchIntervalInBackground: false, o padrão); ao voltar, refaz na hora o que passou do intervalo.
// Desligado, nada se refaz sozinho e cada consulta fica com o próprio `staleTime`.
export function autoSync(minutes: SyncInterval, staleTime: number) {
  if (minutes === 0) return { staleTime, refetchInterval: false, refetchOnWindowFocus: false } as const;
  const ms = minutes * 60_000;
  return { staleTime: ms, refetchInterval: ms, refetchOnWindowFocus: true } as const;
}
