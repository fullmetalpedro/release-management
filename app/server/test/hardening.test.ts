import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JsonClient, ProviderHttpError } from '../src/adapters/http-json.ts';
import { PatTransport } from '../src/adapters/http/patTransport.ts';
import { buildServer } from '../src/adapters/http/server.ts';
import { toStateCategory } from '../src/adapters/azure-devops/workTracking.ts';
import { MANOEL, PEDRO } from '../src/adapters/memory/world.ts';
import { SessionStore } from '../src/adapters/session/sessionStore.ts';
import { loadConfig } from '../src/config.ts';
import { NotAuthenticatedError, ValidationError } from '../src/core/domain/errors.ts';
import type { PullRequest } from '../src/core/domain/types.ts';
import { classify } from '../src/core/usecases/board.ts';
import { createRelease } from '../src/core/usecases/releaseLane.ts';
import { DEFAULT_RELEASE_PATTERN } from '../src/core/usecases/releaseNaming.ts';
import { MemorySourceControl } from '../src/adapters/memory/memoryAdapters.ts';
import { createWorld } from '../src/adapters/memory/world.ts';
import { localeFrom } from '../src/i18n.ts';
import { ConnectionRegistry } from '../src/registry.ts';

// O mesmo envelope que o navegador monta.
function seal(transport: PatTransport, payload: object) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const sealed = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  const wrapped = publicEncrypt(
    {
      key: createPublicKey({ key: Buffer.from(transport.publicKeySpki, 'base64'), format: 'der', type: 'spki' }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    key,
  );
  return Buffer.concat([wrapped, iv, sealed, cipher.getAuthTag()]).toString('base64');
}

describe('transporte do token', () => {
  it('abre um token maior que o limite do RSA (os do Jira passam de 190 caracteres)', () => {
    const transport = new PatTransport();
    const token = 'ATATT' + 'x'.repeat(300);
    expect(transport.decrypt(seal(transport, { nonce: transport.issueNonce(), token }))).toBe(token);
  });

  it('cada envelope vale uma vez só', () => {
    const transport = new PatTransport();
    const envelope = seal(transport, { nonce: transport.issueNonce(), token: 'pat-' + 'a'.repeat(40) });
    transport.decrypt(envelope);
    expect(() => transport.decrypt(envelope)).toThrow(ValidationError);
  });

  it('recusa nonce desconhecido, vencido ou envelope adulterado', () => {
    let now = 0;
    const transport = new PatTransport(() => now);
    expect(() => transport.decrypt(seal(transport, { nonce: 'inventado', token: 'x' }))).toThrow(ValidationError);

    const nonce = transport.issueNonce();
    now = 3 * 60 * 1000;
    expect(() => transport.decrypt(seal(transport, { nonce, token: 'x' }))).toThrow(ValidationError);

    const envelope = Buffer.from(seal(transport, { nonce: transport.issueNonce(), token: 'x' }), 'base64');
    envelope[envelope.length - 20]! ^= 1;
    expect(() => transport.decrypt(envelope.toString('base64'))).toThrow(ValidationError);
  });
});

describe('servidor: entradas hostis', () => {
  async function demoServer() {
    const loaded = loadConfig({ AUTH_MODE: 'demo' });
    const config = { ...loaded, demoFaults: { ...loaded.demoFaults, latencyMs: 0 } };
    const sessions = new SessionStore(config.sessionSecret);
    const app = await buildServer({ config, sessions, registry: new ConnectionRegistry(config, sessions), webDist: '/nao-existe' });
    const login = await app.inject({ method: 'GET', url: '/auth/microsoft/login' });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    return { app, cookie, sessions };
  }
  const write = (cookie: string) => ({ cookie, 'x-requested-with': 'fetch' });

  it('manda os cabeçalhos de segurança em toda resposta', async () => {
    const { app } = await demoServer();
    const { headers } = await app.inject({ method: 'GET', url: '/auth/mode' });
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('recusa id de projeto ou repositório que sairia do caminho no provedor', async () => {
    const { app, cookie } = await demoServer();
    for (const id of ['..%2F..%2Foutra-org%2Fproj', 'a%3Fb', 'a%23b', 'a%25b']) {
      const response = await app.inject({ method: 'GET', url: `/api/projects/${id}/board`, headers: { cookie } });
      expect(response.statusCode, id).toBe(400);
    }
    const link = await app.inject({
      method: 'PUT',
      url: '/api/projects/p-getnota/repositories/r-getnota-api/pull-requests/12abc/work-items/1',
      headers: write(cookie),
    });
    expect(link.statusCode).toBe(400);
  });

  it('limita a lista de PRs de uma release', async () => {
    const { app, cookie } = await demoServer();
    const url = '/api/projects/p-getnota/repositories/r-getnota-api/releases';
    const post = (pullRequestIds: unknown) => app.inject({ method: 'POST', url, headers: write(cookie), payload: { name: 'release/9.9', pullRequestIds } });
    expect((await post(Array.from({ length: 101 }, (_, i) => i + 1))).statusCode).toBe(400);
    expect((await post([])).statusCode).toBe(400);
    expect((await post([-1])).statusCode).toBe(400);
    expect((await post([1.5])).statusCode).toBe(400);
  });

  it('JSON malformado e parâmetro repetido são erro de quem chamou, não erro interno', async () => {
    const { app, cookie } = await demoServer();
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/projects/p-getnota/repositories/r-getnota-api/releases',
      headers: { ...write(cookie), 'content-type': 'application/json' },
      payload: '{"name":',
    });
    expect(malformed.statusCode).toBe(400);
    const repeated = await app.inject({ method: 'GET', url: '/api/projects/p-getnota/work-items?q=a&q=b', headers: { cookie } });
    expect(repeated.statusCode).toBe(200);
  });

  it('sair exige o cabeçalho das escritas, e entrar de novo na demonstração não acumula sessões', async () => {
    const { app, cookie } = await demoServer();
    const again = await app.inject({ method: 'GET', url: '/auth/microsoft/login', headers: { cookie } });
    expect(again.headers['set-cookie']).toBeUndefined();

    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: write(cookie) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('responde 429 quando as tentativas de entrada passam do limite', async () => {
    const { app } = await demoServer();
    let last = 200;
    for (let i = 0; i < 61 && last !== 429; i++) {
      last = (await app.inject({ method: 'GET', url: '/auth/microsoft/login' })).statusCode;
    }
    expect(last).toBe(429);
    const blocked = await app.inject({ method: 'GET', url: '/auth/microsoft/login' });
    expect(blocked.json()).toMatchObject({ code: 'rate-limited' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('cliente HTTP dos provedores', () => {
  const client = (responses: Response[]) => {
    let calls = 0;
    const json = new JsonClient({
      provider: 'github',
      label: 'GitHub',
      baseUrl: 'https://api.github.com',
      headers: async () => ({ Authorization: 'Bearer t' }),
      fetchImpl: async () => responses[Math.min(calls++, responses.length - 1)]!.clone(),
      retryDelayMs: 0,
    });
    return { json, calls: () => calls };
  };

  it('redirecionamento não é token recusado (branch renomeada no GitHub responde 301)', async () => {
    const { json } = client([new Response('{}', { status: 301, headers: { location: 'https://api.github.com/x' } })]);
    const error = await json.get('/repos/o/r/branches/master').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).not.toBeInstanceOf(NotAuthenticatedError);
    expect((error as ProviderHttpError).status).toBe(301);
  });

  it('repete leituras em 429 e 503, mas não escritas', async () => {
    const busy = () => new Response('{}', { status: 503 });
    const ok = () => Response.json({ ok: true });
    const read = client([new Response('{}', { status: 429 }), busy(), ok()]);
    expect(await read.json.get('/x')).toEqual({ ok: true });
    expect(read.calls()).toBe(3);

    const write = client([busy(), ok()]);
    await expect(write.json.json('/x', { method: 'POST', body: {} })).rejects.toBeInstanceOf(ProviderHttpError);
    expect(write.calls()).toBe(1);
  });

  it('401 continua encerrando a sessão', async () => {
    const { json } = client([new Response('{}', { status: 401 })]);
    await expect(json.get('/user')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

describe('regras revistas', () => {
  const pull = (overrides: Partial<PullRequest>): PullRequest => ({
    provider: 'azure-devops',
    id: 1,
    title: 't',
    repository: { id: 'r', name: 'r', projectId: 'p' },
    sourceBranch: 'f',
    targetBranch: 'develop',
    author: MANOEL,
    createdAt: '2026-10-01T00:00:00Z',
    status: 'open',
    isDraft: false,
    mergeState: 'clean',
    conflictCount: 0,
    commentCount: 0,
    reviews: [],
    webUrl: '',
    ...overrides,
  });
  const colleague = { ...MANOEL, id: 'colega' };

  it('revisor obrigatório com voto pendente segura o PR mesmo com o mínimo de aprovações atingido', () => {
    const reviews = [
      { reviewer: PEDRO, decision: 'pending' as const, required: true },
      { reviewer: colleague, decision: 'approved' as const, required: false },
    ];
    expect(classify(pull({ requiredApprovals: 1, reviews }), PEDRO)).toEqual({ column: 'dependsOnMe', reason: 'reviewer' });
  });

  it('rascunho aprovado não está pronto para merge', () => {
    const reviews = [{ reviewer: colleague, decision: 'approved' as const, required: false }];
    expect(classify(pull({ isDraft: true, reviews }), PEDRO).column).toBe('review');
  });

  it('estado concluído não vira "em teste" pelo nome', () => {
    expect(toStateCategory('Testado', 'Completed')).toBe('done');
    expect(toStateCategory('Em teste', 'InProgress')).toBe('testing');
  });

  it('recusa criar release com nome fora do padrão, que nunca apareceria como release', async () => {
    const branching = { developBranch: 'develop', baseBranches: ['main'], releasePattern: DEFAULT_RELEASE_PATTERN, firstRelease: 'release/1.0' };
    const sourceControl = new MemorySourceControl(createWorld());
    await expect(
      createRelease({ sourceControl }, { projectId: 'p-getnota', repositoryId: 'r-getnota-api', name: 'release/2.16-hotfix', pullRequestIds: [1295], branching }),
    ).rejects.toThrow(ValidationError);
  });

  it('Accept-Language segue o peso de cada idioma', () => {
    expect(localeFrom('en;q=0.1, fr')).toBe('fr');
    expect(localeFrom('fr;q=0, en')).toBe('en');
    expect(localeFrom('de, en-US;q=0.8, fr;q=0.9')).toBe('fr');
    expect(localeFrom('de')).toBe('pt');
    expect(localeFrom(undefined)).toBe('pt');
  });
});

describe('envelope montado com WebCrypto, como no navegador', () => {
  it('o servidor abre o que web/src/lib/pat.ts monta', async () => {
    const transport = new PatTransport();
    const token = 'ATATT' + 'ç'.repeat(40) + 'x'.repeat(200);
    const nonce = transport.issueNonce();
    const { subtle } = globalThis.crypto;

    const wrappingKey = await subtle.importKey('spki', Buffer.from(transport.publicKeySpki, 'base64'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    const rawKey = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
    const wrappedKey = await subtle.encrypt({ name: 'RSA-OAEP' }, wrappingKey, rawKey);
    const sealed = await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(JSON.stringify({ nonce, token })));
    const envelope = Buffer.concat([Buffer.from(wrappedKey), Buffer.from(iv), Buffer.from(sealed)]).toString('base64');

    expect(transport.decrypt(envelope)).toBe(token);
  });
});

describe('PR sem revisor', () => {
  it('fica em revisão e o card avisa que ninguém foi chamado para revisar', async () => {
    const { getBoard } = await import('../src/core/usecases/board.ts');
    const board = await getBoard({ sourceControl: new MemorySourceControl(createWorld()) }, 'p-getnota');
    const card = board.columns.review.find((pr) => pr.id === 1290);
    expect(card).toMatchObject({ noReviewers: true, approved: false });
    expect(board.columns.review.filter((pr) => pr.id !== 1290).every((pr) => !pr.noReviewers)).toBe(true);
  });
});

describe('achados do teste de caos', () => {
  async function demoServer() {
    const loaded = loadConfig({ AUTH_MODE: 'demo' });
    const config = { ...loaded, demoFaults: { ...loaded.demoFaults, latencyMs: 5 } };
    const sessions = new SessionStore(config.sessionSecret);
    const app = await buildServer({ config, sessions, registry: new ConnectionRegistry(config, sessions), webDist: '/nao-existe' });
    const login = await app.inject({ method: 'GET', url: '/auth/microsoft/login' });
    return { app, cookie: String(login.headers['set-cookie']).split(';')[0]! };
  }

  it('duas criações simultâneas da mesma release: uma cria, as outras recebem "já existe"', async () => {
    const { app, cookie } = await demoServer();
    const create = () =>
      app.inject({
        method: 'POST',
        url: '/api/projects/p-getnota/repositories/r-getnota-api/releases',
        headers: { cookie, 'x-requested-with': 'fetch' },
        payload: { name: 'release/2.16', pullRequestIds: [1295, 1294] },
      });
    const statuses = (await Promise.all(Array.from({ length: 8 }, create))).map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 400, 400, 400, 400, 400, 400, 400]);
  });

  it('erros barrados antes das rotas saem com os cabeçalhos de segurança e sem texto do framework', async () => {
    const { app, cookie } = await demoServer();
    const cases = [
      ['/api/projects/%E0%A4%A/board', 400],
      [`/api/avatars/${'x'.repeat(600)}`, 414],
      ['/api/rota-que-nao-existe', 404],
    ] as const;
    for (const [url, status] of cases) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(response.statusCode, url).toBe(status);
      expect(response.headers['x-frame-options'], url).toBe('DENY');
      expect(response.headers['content-security-policy'], url).toContain("frame-ancestors 'none'");
      expect(response.json(), url).toHaveProperty('code');
      expect(response.body, url).not.toContain('Route GET');
    }
  });

  it('token com quebra de linha ou caractere de controle é recusado', async () => {
    const config = loadConfig({ SESSION_SECRET: 'x'.repeat(32) });
    const sessions = new SessionStore(config.sessionSecret);
    let validated = 0;
    const app = await buildServer({
      config,
      sessions,
      registry: new ConnectionRegistry(config, sessions),
      webDist: '/nao-existe',
      validatePat: async () => {
        validated += 1;
        return { owner: { id: 'u', name: 'U' } };
      },
    });
    for (const token of ['tok\r\nX-Injected: 1' + 'a'.repeat(30), 'tok\u0000' + 'a'.repeat(30), 'tok com espaço ' + 'a'.repeat(30)]) {
      const { publicKey, nonce } = (await app.inject({ method: 'GET', url: '/auth/pat/key' })).json();
      const key = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(JSON.stringify({ nonce, token })), cipher.final()]);
      const wrapped = publicEncrypt(
        { key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        key,
      );
      const response = await app.inject({
        method: 'POST',
        url: '/auth/pat/github',
        headers: { 'x-requested-with': 'fetch' },
        payload: { organization: 'muralis', encryptedToken: Buffer.concat([wrapped, iv, sealed, cipher.getAuthTag()]).toString('base64') },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(validated).toBe(0);
  });

  it('o número de sessões guardadas tem teto', () => {
    const sessions = new SessionStore('s'.repeat(32));
    const first = sessions.create({ mode: 'demo', user: { name: 'primeira' } });
    for (let i = 0; i < 10_000; i++) sessions.create({ mode: 'demo', user: { name: 'outra' } });
    expect(sessions.get(first.id)).toBeUndefined();
  });
});
