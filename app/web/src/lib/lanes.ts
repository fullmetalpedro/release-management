import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { autoSync, useSyncInterval } from './sync';

// Trocar de repositório não deve disparar nova sincronização: os dados valem até o próximo "Atualizar".
export const LANE_STALE_MS = 10 * 60_000;

export const laneKey = (projectId: string | undefined, repositoryId: string | undefined) =>
  ['lane', projectId, repositoryId] as const;
export const releaseKey = (projectId: string | undefined, repositoryId: string | undefined, branch?: string) =>
  ['release', projectId, repositoryId, branch ?? null] as const;

// Carrega as raias de todos os repositórios do projeto numa chamada só e as distribui no cache por repositório.
export function useAllLanes(projectId: string | undefined) {
  const queryClient = useQueryClient();
  const [interval] = useSyncInterval();
  return useQuery({
    queryKey: ['lanes', projectId],
    queryFn: async () => {
      const result = await api.lanes(projectId!);
      // Semeia antes de devolver, para as colunas já encontrarem o dado quando forem habilitadas.
      for (const lane of result.lanes) queryClient.setQueryData(laneKey(projectId, lane.repository.id), lane);
      return result;
    },
    enabled: !!projectId,
    gcTime: 3 * LANE_STALE_MS,
    ...autoSync(interval, LANE_STALE_MS),
    retry: false,
  });
}
