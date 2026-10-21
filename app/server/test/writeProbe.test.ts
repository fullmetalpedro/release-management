import { describe, expect, it } from 'vitest';
import { ProviderHttpError } from '../src/adapters/http-json.ts';
import { writeAllowed } from '../src/adapters/writeProbe.ts';
import { NotAuthenticatedError, ProviderUnavailableError } from '../src/core/domain/errors.ts';

const failing = (error: Error) => async () => {
  throw error;
};

describe('sondagem de escrita', () => {
  it('recusa por permissão quer dizer token só de leitura', async () => {
    expect(await writeAllowed(failing(new NotAuthenticatedError()))).toBe(false);
    expect(await writeAllowed(failing(new ProviderHttpError('github', 403, 'Resource not accessible by personal access token')))).toBe(false);
  });

  it('erro de validação ou recurso inexistente quer dizer que a permissão passou', async () => {
    expect(await writeAllowed(async () => ({ value: [{ success: false }] }))).toBe(true);
    expect(await writeAllowed(failing(new ProviderHttpError('github', 422, 'Object does not exist')))).toBe(true);
    expect(await writeAllowed(failing(new ProviderHttpError('jira', 404, 'Issue does not exist')))).toBe(true);
    expect(await writeAllowed(failing(new ProviderUnavailableError('azure-devops', 'test failed', 400)))).toBe(true);
  });

  it('falha do provedor ou da rede fica sem resposta', async () => {
    expect(await writeAllowed(failing(new ProviderUnavailableError('azure-devops', 'fora do ar', 503)))).toBeUndefined();
    expect(await writeAllowed(failing(new Error('ECONNRESET')))).toBeUndefined();
  });
});
