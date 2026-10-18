import { NotAuthenticatedError, ProviderUnavailableError } from '../core/domain/errors.ts';

// Descobre se o token pode escrever, com um pedido de escrita que o provedor não aplica (uma branch que não existe,
// uma validação que falha de propósito). Recusa por permissão (401, 403) quer dizer token só de leitura; erro de
// validação ou recurso inexistente quer dizer que a permissão passou e só o conteúdo foi recusado. Qualquer outra
// coisa (rede, 5xx) fica sem resposta, e a primeira escrita de verdade decide.
export async function writeAllowed(probe: () => Promise<unknown>): Promise<boolean | undefined> {
  try {
    await probe();
    return true;
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return false;
    const status = error instanceof ProviderUnavailableError ? error.status : undefined;
    if (status === 403) return false;
    if (status !== undefined && status >= 400 && status < 500) return true;
    return undefined;
  }
}

// Nome de branch que nunca é criada: o pedido só remove, e só se ela existisse com este commit.
export const PROBE_BRANCH = 'refs/heads/rm-access-probe';
export const IMPOSSIBLE_SHA = 'f'.repeat(40);
