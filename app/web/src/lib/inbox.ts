import { useQuery } from '@tanstack/react-query';
import { api } from './api';

// A caixa de entrada passa por todas as organizações e projetos: é cara, então vale por um minuto e se atualiza a cada
// cinco. A aba no topo e a página compartilham a mesma consulta.
export function useInbox() {
  return useQuery({ queryKey: ['inbox'], queryFn: api.inbox, staleTime: 60_000, refetchInterval: 5 * 60_000 });
}
