import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { autoSync, useSyncInterval } from './sync';

// A caixa de entrada passa por todas as organizações e projetos: é cara, então segue o intervalo de sincronização
// escolhido no board e, desligado, vale por um minuto. A aba no topo e a página compartilham a mesma consulta.
export function useInbox() {
  const [syncInterval] = useSyncInterval();
  return useQuery({ queryKey: ['inbox'], queryFn: api.inbox, ...autoSync(syncInterval, 60_000) });
}
