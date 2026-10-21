import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AZURE_DEVOPS_SCOPE, EntraIdentityProvider } from '../src/adapters/entra/identityProvider.ts';
import type { PatValidator } from '../src/adapters/http/patProviders.ts';
import { buildServer } from '../src/adapters/http/server.ts';
import { MemorySourceControl, MemoryWorkTracking } from '../src/adapters/memory/memoryAdapters.ts';
import { createWorld } from '../src/adapters/memory/world.ts';
import { connectionOf, SessionStore } from '../src/adapters/session/sessionStore.ts';
import { loadConfig } from '../src/config.ts';
import { NotAuthenticatedError } from '../src/core/domain/errors.ts';
import type { IdentityProvider } from '../src/core/ports/identityProvider.ts';
import { ConnectionRegistry, expiringAs } from '../src/registry.ts';
import type { WorkTracking } from '../src/core/ports/workTracking.ts';

const entra = {
  tenantId: 'tenant-1',
  clientId: 'client-1',
  clientSecret: 'segredo',
  redirectUri: 'http://localhost:5173/auth/microsoft/callback',
};

function idToken(claims: object) {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.`;
}

describe('login com Microsoft', () => {
  it('monta a URL de autorização com PKCE e o escopo do Azure DevOps', () => {
    const login = new EntraIdentityProvider(entra).beginLogin();
    const url = new URL(login.url);
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/tenant-1/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(entra.redirectUri);
    expect(url.searchParams.get('state')).toBe(login.state);
    expect(url.searchParams.get('scope')!.split(' ')).toEqual(
      expect.arrayContaining([AZURE_DEVOPS_SCOPE, 'openid', 'offline_access']),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(
      createHash('sha256').update(login.codeVerifier).digest('base64url'),
    );
  });

  it('troca o código por tokens e lê o perfil do id token', async () => {
    let sent: URLSearchParams | undefined;
    const provider = new EntraIdentityProvider(
      entra,
      async (_url, init) => {
        sent = new URLSearchParams(String(init!.body));
        return Response.json({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          id_token: idToken({ name: 'Alex Rivera', preferred_username: 'alex.rivera@example.com' }),
        });
      },
      () => 1_000,
    );
    const result = await provider.completeLogin('codigo', 'verificador');

    expect(result.profile).toEqual({ name: 'Alex Rivera', email: 'alex.rivera@example.com' });
    expect(result.tokens).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 3_601_000 });
    expect(Object.fromEntries(sent!)).toMatchObject({
      grant_type: 'authorization_code',
      code: 'codigo',
      code_verifier: 'verificador',
      client_secret: 'segredo',
    });
  });

  it('mantém o refresh token anterior quando a renovação não devolve outro', async () => {
    const provider = new EntraIdentityProvider(entra, async () => Response.json({ access_token: 'novo', expires_in: 60 }), () => 0);
    expect(await provider.refresh('rt-antigo')).toEqual({ accessToken: 'novo', refreshToken: 'rt-antigo', expiresAt: 60_000 });
  });

  it('refresh token revogado encerra a sessão', async () => {
    const provider = new EntraIdentityProvider(entra, async () =>
      Response.json({ error: 'invalid_grant', error_description: 'AADSTS70008' }, { status: 400 }),
    );
    await expect(provider.refresh('rt')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });
});

describe('sessões', () => {
  it('sobrevive a um restart sem guardar tokens em claro', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rm-')), 'sessions.enc');
    const secret = 'x'.repeat(32);
    const session = new SessionStore(secret, file).create({
      mode: 'microsoft',
      user: { name: 'Alex Rivera' },
      tokens: { accessToken: 'at-secreto', refreshToken: 'rt-secreto', expiresAt: 1 },
    });

    expect(readFileSync(file).toString('latin1')).not.toMatch(/secreto|Alex/);
    expect(new SessionStore(secret, file).get(session.id)?.tokens?.refreshToken).toBe('rt-secreto');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(new SessionStore('y'.repeat(32), file).get(session.id)).toBeUndefined();
    // Trocar o segredo invalida o arquivo, e isso aparece no log.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SESSION_SECRET mudou'));
    warn.mockRestore();
  });

  it('sem arquivo gravado é o primeiro boot: nada a avisar', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new SessionStore('x'.repeat(32), join(mkdtempSync(join(tmpdir(), 'rm-')), 'sessions.enc'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  describe('validade', () => {
    afterEach(() => vi.useRealTimers());
    const hours = (n: number) => n * 60 * 60 * 1000;
    const days = (n: number) => n * hours(24);

    it('vence depois de SESSION_MAX_AGE_DAYS sem uso', () => {
      vi.useFakeTimers({ toFake: ['Date'], now: 0 });
      const store = new SessionStore('x'.repeat(32), undefined, { maxAgeDays: 7 });
      expect(store.maxAgeMs).toBe(days(7));
      const session = store.create({ mode: 'demo', user: { name: 'Alex' } });
      vi.setSystemTime(days(7) - 1);
      expect(store.get(session.id)).toBeDefined();
      vi.setSystemTime(days(7) + 1);
      expect(store.get(session.id)).toBeUndefined();
    });

    it('cada uso renova a validade, gravando no máximo uma vez por hora', () => {
      vi.useFakeTimers({ toFake: ['Date'], now: 0 });
      const file = join(mkdtempSync(join(tmpdir(), 'rm-')), 'sessions.enc');
      const secret = 'x'.repeat(32);
      const store = new SessionStore(secret, file, { maxAgeDays: 7 });
      const session = store.create({ mode: 'demo', user: { name: 'Alex' } });
      const written = () => readFileSync(file).toString('base64');

      const before = written();
      vi.setSystemTime(hours(1) - 1);
      expect(store.touch(session.id)).toBe(false);
      expect(written()).toBe(before);

      // Usando todo dia, passa dos 7 dias contados da criação sem ser deslogado.
      for (let day = 1; day <= 20; day++) {
        vi.setSystemTime(days(day));
        expect(store.touch(session.id)).toBe(true);
      }
      expect(written()).not.toBe(before);
      expect(new SessionStore(secret, file, { maxAgeDays: 7 }).get(session.id)?.lastSeenAt).toBe(days(20));

      // Parado por mais de 7 dias, vence.
      vi.setSystemTime(days(27) + 1);
      expect(store.touch(session.id)).toBe(false);
      expect(store.get(session.id)).toBeUndefined();
    });
  });
});

describe('configuração', () => {
  it('sem nada configurado só há token pessoal; app registration exige o resto; demonstração é opcional', () => {
    expect(loadConfig({})).toMatchObject({ demo: false, organization: '', sessionFile: undefined });
    expect(loadConfig({}).entra).toBeUndefined();
    expect(loadConfig({ AUTH_MODE: 'demo' })).toMatchObject({ demo: true, organization: 'demo' });
    expect(loadConfig({ SESSION_SECRET: 'x'.repeat(32) }).sessionFile).toMatch(/sessions\.enc$/);
    expect(() => loadConfig({ SESSION_SECRET: 'curto' })).toThrow('32 caracteres');
    expect(loadConfig({}).sessionMaxAgeDays).toBe(30);
    expect(loadConfig({ SESSION_MAX_AGE_DAYS: '7' }).sessionMaxAgeDays).toBe(7);
    expect(loadConfig({ AUTH_MODE: 'demo', SESSION_MAX_AGE_DAYS: '7' }).sessionMaxAgeDays).toBe(7);
    expect(() => loadConfig({ SESSION_MAX_AGE_DAYS: '0' })).toThrow('SESSION_MAX_AGE_DAYS');
    expect(() => loadConfig({ SESSION_MAX_AGE_DAYS: 'sete' })).toThrow('SESSION_MAX_AGE_DAYS');
    expect(() => loadConfig({ ENTRA_CLIENT_ID: 'c' })).toThrow('SESSION_SECRET');
    const config = loadConfig({
      ENTRA_CLIENT_ID: 'c',
      ENTRA_TENANT_ID: 't',
      ENTRA_CLIENT_SECRET: 's',
      AZDO_ORG: 'acme',
      SESSION_SECRET: 'x'.repeat(32),
      AZDO_PROJECTS: 'Invoicing, Trade Desk ,Scheduler',
      APP_URL: 'https://rm.example.com/',
    });
    expect(config).toMatchObject({
      demo: false,
      organization: 'acme',
      projects: ['Invoicing', 'Trade Desk', 'Scheduler'],
      entra: { redirectUri: 'https://rm.example.com/auth/microsoft/callback' },
    });
  });
});

describe('servidor HTTP', () => {
  async function demoServer(env: NodeJS.ProcessEnv = {}) {
    const loaded = loadConfig({ AUTH_MODE: 'demo', ...env });
    const config = { ...loaded, demoFaults: { ...loaded.demoFaults, latencyMs: 0 } };
    const sessions = new SessionStore(config.sessionSecret);
    const app = await buildServer({ config, sessions, registry: new ConnectionRegistry(config, sessions), webDist: '/nao-existe' });
    const login = await app.inject({ method: 'GET', url: '/auth/microsoft/login' });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    return { app, cookie, login };
  }

  it('recusa a API sem sessão', async () => {
    const { app } = await demoServer();
    const response = await app.inject({ method: 'GET', url: '/api/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('entra, lista projetos e carrega o board', async () => {
    const { app, cookie, login } = await demoServer({ AZDO_PROJECTS: 'Invoicing,Trade Desk,Scheduler' });
    expect(login.statusCode).toBe(302);
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly/i);

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ user: { name: 'Alex Rivera' }, demo: true });
    expect(me.json().accounts.filter((a: { connected: boolean }) => a.connected)).toEqual([
      { provider: 'azure-devops', connected: true, active: true, handle: 'alex.rivera@example.com' },
    ]);

    const projects = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(projects.json().map((p: { name: string; openPullRequests: number }) => [p.name, p.openPullRequests])).toEqual([
      ['Invoicing', 11],
      ['Trade Desk', 4],
      ['Scheduler', 7],
    ]);

    const board = await app.inject({ method: 'GET', url: '/api/projects/p-invoicing/board', headers: { cookie } });
    expect(board.json().columns.dependsOnMe).toHaveLength(4);
  });

  it('exige o cabeçalho anti-CSRF nas escritas e devolve 409 no conflito', async () => {
    const { app, cookie } = await demoServer({ DEMO_FAIL: 'conflict:1291' });
    const url = '/api/projects/p-invoicing/repositories/r-invoicing-api/releases';
    const payload = { name: 'release/2.16', pullRequestIds: [1295, 1291] };

    const forged = await app.inject({ method: 'POST', url, headers: { cookie }, payload });
    expect(forged.statusCode).toBe(400);

    const conflict = await app.inject({ method: 'POST', url, headers: { cookie, 'x-requested-with': 'fetch' }, payload });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ code: 'cherry-pick-conflict', pullRequestId: 1291, baseBranch: 'main' });

    const ok = await app.inject({
      method: 'POST',
      url,
      headers: { cookie, 'x-requested-with': 'fetch' },
      payload: { name: 'release/2.16', pullRequestIds: [1295] },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ name: 'release/2.16', pullRequests: 1 });
  });

  it('falha de sincronização vira 502 e sair encerra a sessão', async () => {
    const { app, cookie } = await demoServer({ DEMO_FAIL: 'sync' });
    const board = await app.inject({ method: 'GET', url: '/api/projects/p-invoicing/board', headers: { cookie } });
    expect(board.statusCode).toBe(502);
    expect(board.json()).toMatchObject({ code: 'provider-unavailable', provider: 'azure-devops' });

    await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, 'x-requested-with': 'fetch' } });
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('conclui o login da Microsoft conferindo o state', async () => {
    const config = loadConfig({
      ENTRA_CLIENT_ID: 'c',
      ENTRA_TENANT_ID: 't',
      ENTRA_CLIENT_SECRET: 's',
      AZDO_ORG: 'acme',
      SESSION_SECRET: 'x'.repeat(32),
      DATA_DIR: mkdtempSync(join(tmpdir(), 'rm-')),
    });
    const identityProvider: IdentityProvider = {
      beginLogin: () => ({ url: 'https://login.example/authorize', state: 'estado', codeVerifier: 'verificador' }),
      completeLogin: async (code, verifier) => {
        expect([code, verifier]).toEqual(['codigo', 'verificador']);
        return { tokens: { accessToken: 'at', expiresAt: Date.now() + 3_600_000 }, profile: { name: 'Alex Rivera' } };
      },
      refresh: async () => ({ accessToken: 'at', expiresAt: 0 }),
    };
    const sessions = new SessionStore(config.sessionSecret);
    // O teste não sai para a internet: no lugar do Azure DevOps entram os adapters de memória.
    const registry = new ConnectionRegistry(config, sessions, identityProvider);
    const world = createWorld();
    registry.for = () => ({ sourceControl: new MemorySourceControl(world), workTracking: new MemoryWorkTracking(world) });
    const app = await buildServer({ config, sessions, registry, identityProvider, webDist: '/nao-existe' });

    const start = await app.inject({ method: 'GET', url: '/auth/microsoft/login' });
    expect(start.headers.location).toBe('https://login.example/authorize');
    const oauthCookie = String(start.headers['set-cookie']).split(';')[0]!;

    const forged = await app.inject({ method: 'GET', url: '/auth/microsoft/callback?code=codigo&state=outro', headers: { cookie: oauthCookie } });
    expect(forged.headers.location).toBe('http://localhost:5173/login?erro=falha');

    // Com app registration, as duas formas de entrar convivem no mesmo servidor.
    expect((await app.inject({ method: 'GET', url: '/auth/mode' })).json()).toMatchObject({ microsoft: true, pat: true, demo: false });
    expect((await app.inject({ method: 'GET', url: '/auth/pat/key' })).statusCode).toBe(200);

    const done = await app.inject({ method: 'GET', url: '/auth/microsoft/callback?code=codigo&state=estado', headers: { cookie: oauthCookie } });
    expect(done.headers.location).toBe('http://localhost:5173');
    const sessionCookie = [done.headers['set-cookie']].flat().map(String).find((c) => c.startsWith('rm_session='))!.split(';')[0]!;
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: sessionCookie } });
    expect(me.json()).toMatchObject({ user: { name: 'Alex Rivera' }, demo: false, organization: 'acme' });
  });
});

describe('conexão por token pessoal', () => {
  const env = { SESSION_SECRET: 'x'.repeat(32), AZDO_ORG: 'acme' };
  const token = 'pat-' + 'a'.repeat(60);
  const alex = { id: 'u1', name: 'Alex Rivera', email: 'alex.rivera@example.com' };

  async function patServer(validatePat: PatValidator = async () => ({ owner: alex }), extraEnv: NodeJS.ProcessEnv = {}) {
    const file = join(mkdtempSync(join(tmpdir(), 'rm-')), 'sessions.enc');
    const config = { ...loadConfig({ ...env, ...extraEnv }), sessionFile: file };
    const sessions = new SessionStore(config.sessionSecret, file, { maxAgeDays: config.sessionMaxAgeDays });
    // Os adapters reais chamariam os provedores; com uma organização ativa, os testes usam os de memória. As contas
    // em `rejected` têm o token recusado pelo provedor, como um PAT vencido.
    const registry = new ConnectionRegistry(config, sessions);
    const real = registry.for.bind(registry);
    const world = createWorld();
    const rejected = new Set<string>();
    // Contas com token só de leitura: leem normalmente, e o provedor recusa as escritas com 401.
    const readOnly = new Set<string>();
    const writes = new Set(['createReleaseBranch', 'linkPullRequest', 'unlinkPullRequest']);
    const memory = <T extends object>(account: string, adapter: T): T => {
      if (rejected.has(account)) return new Proxy(adapter, { get: () => async () => { throw new NotAuthenticatedError(); } });
      if (readOnly.has(account)) {
        return new Proxy(adapter, {
          get: (object, property, receiver) =>
            writes.has(String(property)) ? async () => { throw new NotAuthenticatedError(); } : Reflect.get(object, property, receiver),
        });
      }
      return adapter;
    };
    registry.for = (session) => {
      const id = session.activeConnection;
      const active = connectionOf(session, id);
      if (!id || !active) return real(session);
      // Com o GitHub ativo, as tarefas vêm do Jira conectado, que também pode ter o token recusado.
      const [jiraId, jira] = Object.entries(session.connections ?? {}).find(([, c]) => c.provider === 'jira') ?? [];
      const sourceControl = memory(active.account, new MemorySourceControl(world));
      const verify = () => sourceControl.listProjects();
      let workTracking: WorkTracking = expiringAs(id, active, memory(active.account, new MemoryWorkTracking(world)), verify);
      if (active.provider === 'github') {
        const tracking = jiraId && jira ? memory(jira.account, new MemoryWorkTracking(world)) : undefined;
        workTracking = tracking ? expiringAs(jiraId!, jira!, tracking, () => tracking.searchWorkItems('', 'x')) : new MemoryWorkTracking(world);
      }
      return { sourceControl: expiringAs(id, active, sourceControl, verify), workTracking };
    };
    registry.sources = (session) =>
      Object.entries(session.connections ?? {})
        .filter(([, connection]) => connection.provider !== 'jira')
        .map(([id, connection]) => ({
          id,
          provider: connection.provider as 'azure-devops' | 'github',
          account: connection.account,
          expired: !!connection.expiredAt,
          connection: connection.expiredAt
            ? undefined
            : {
                sourceControl: expiringAs(id, connection, memory(connection.account, new MemorySourceControl(world))),
                workTracking: new MemoryWorkTracking(world),
              },
        }));
    const app = await buildServer({ config, sessions, registry, webDist: '/nao-existe', validatePat });
    // O mesmo envelope que o navegador monta: chave AES embrulhada com RSA-OAEP | IV | { nonce, token } em AES-GCM.
    const encrypt = async (plain: string, reuse?: { nonce: string }) => {
      const { publicKey, nonce } = (await app.inject({ method: 'GET', url: '/auth/pat/key' })).json();
      const key = randomBytes(32);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const sealed = Buffer.concat([cipher.update(JSON.stringify({ nonce: reuse?.nonce ?? nonce, token: plain })), cipher.final()]);
      const wrapped = publicEncrypt(
        { key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        key,
      );
      return Buffer.concat([wrapped, iv, sealed, cipher.getAuthTag()]).toString('base64');
    };
    const connect = (provider: string, body: object, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: `/auth/pat/${provider}`, headers: { 'x-requested-with': 'fetch', ...headers }, payload: body });
    const cookieOf = (response: { headers: Record<string, unknown> }) =>
      [response.headers['set-cookie']].flat().map(String).find((c) => /^rm_session=[^;]{20,}/.test(c))!.split(';')[0]!;
    const me = async (cookie: string) => (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json();
    const sessionOf = (cookie: string) => sessions.get(decodeURIComponent(cookie).match(/rm_session=([^.]+)\./)![1])!;
    return { app, sessions, file, encrypt, connect, cookieOf, me, rejected, readOnly, sessionOf };
  }

  it('está sempre disponível; sem app registration o login com Microsoft é anunciado como indisponível', async () => {
    const { app } = await patServer();
    expect((await app.inject({ method: 'GET', url: '/auth/mode' })).json()).toEqual({
      microsoft: false,
      pat: true,
      demo: false,
      defaultOrganization: 'acme',
      sessionsPersisted: true,
    });
    const login = await app.inject({ method: 'GET', url: '/auth/microsoft/login' });
    expect(login.headers.location).toBe('http://localhost:5173/login?erro=indisponivel');
  });

  it('recebe o token cifrado, valida no provedor e guarda selado', async () => {
    const seen: unknown[] = [];
    const { sessions, file, encrypt, connect, cookieOf, me } = await patServer(async (provider, input) => {
      seen.push([provider, input.account, input.token]);
      return { owner: alex };
    });

    const encryptedToken = await encrypt(token);
    expect(encryptedToken).not.toContain(token);
    const response = await connect('azure-devops', { organization: 'acme', encryptedToken });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 'azure-devops:acme',
      provider: 'azure-devops',
      account: 'acme',
      user: { name: 'Alex Rivera', email: 'alex.rivera@example.com' },
    });
    expect(response.body).not.toContain(token);
    expect(seen).toEqual([['azure-devops', 'acme', token]]);

    const cookie = cookieOf(response);
    expect(cookie).not.toContain(token);
    const profile = await me(cookie);
    expect(profile).toMatchObject({
      mode: 'pat',
      organization: 'acme',
      source: { provider: 'azure-devops', name: 'Azure DevOps' },
      tracker: { provider: 'azure-devops', name: 'Azure DevOps' },
    });
    // Azure DevOps sempre primeiro na lista de contas.
    expect(profile.accounts).toEqual([
      { id: 'azure-devops:acme', provider: 'azure-devops', connected: true, active: true, handle: 'alex.rivera@example.com', account: 'acme' },
      { provider: 'github', connected: false },
      { provider: 'jira', connected: false },
    ]);
    expect(JSON.stringify(profile)).not.toContain(token);

    // Nem o arquivo de sessões nem o objeto em memória carregam o token em claro.
    expect(readFileSync(file).toString('latin1')).not.toContain(token);
    const [, sessionId] = decodeURIComponent(cookie).match(/rm_session=([^.]+)\./)!;
    const stored = sessions.get(sessionId)!;
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(sessions.open(stored.connections!['azure-devops:acme']!.sealedToken)).toBe(token);
  });

  it('token recusado não cria sessão', async () => {
    const { connect, encrypt } = await patServer(async () => {
      throw new NotAuthenticatedError();
    });
    const response = await connect('github', { organization: 'acme', encryptedToken: await encrypt(token) });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: 'invalid-token', message: expect.stringContaining('GitHub') });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('barra conta malformada, token em claro, plataforma desconhecida e requisição de outro site', async () => {
    const { app, connect, encrypt } = await patServer();
    const encryptedToken = await encrypt(token);
    expect((await connect('azure-devops', { organization: 'evil.com/x?', encryptedToken })).statusCode).toBe(400);
    expect((await connect('github', { organization: 'evil.com', encryptedToken })).statusCode).toBe(400);
    expect((await connect('jira', { site: 'evil.com', email: 'a@b.co', encryptedToken })).statusCode).toBe(400);
    expect((await connect('jira', { site: 'acme.atlassian.net', email: 'sem-arroba', encryptedToken })).statusCode).toBe(400);
    expect((await connect('azure-devops', { organization: 'acme', encryptedToken: Buffer.from(token).toString('base64') })).statusCode).toBe(400);
    expect((await connect('gitlab', { organization: 'acme', encryptedToken })).statusCode).toBe(404);
    const forged = await app.inject({ method: 'POST', url: '/auth/pat/azure-devops', payload: { organization: 'acme', encryptedToken } });
    expect(forged.statusCode).toBe(400);
  });

  it('as plataformas se somam na mesma sessão, e a ativa pode ser trocada', async () => {
    const { app, connect, encrypt, cookieOf, me } = await patServer(async (provider) => ({
      owner: provider === 'github' ? { id: 'gh1', name: 'alex-gh', email: 'alex-rivera' } : provider === 'jira' ? { id: 'j1', name: 'Alex Jira', email: 'alex@example.com' } : alex,
      cloudId: provider === 'jira' ? 'cloud-123' : undefined,
    }));
    const first = await connect('azure-devops', { organization: 'acme', encryptedToken: await encrypt(token) });
    const cookie = cookieOf(first);

    const github = await connect('github', { organization: 'acme-gh', encryptedToken: await encrypt(token) }, { cookie });
    expect(github.statusCode).toBe(200);
    expect(github.headers['set-cookie']).toBeUndefined();
    await connect('jira', { site: 'https://Acme.atlassian.net/jira', email: 'alex@example.com', encryptedToken: await encrypt(token) }, { cookie });

    let profile = await me(cookie);
    expect(profile.accounts.map((a: { provider: string; connected: boolean; active?: boolean; account?: string }) => [a.provider, a.connected, a.active, a.account])).toEqual([
      ['azure-devops', true, false, 'acme'],
      ['github', true, true, 'acme-gh'],
      ['jira', true, false, 'acme.atlassian.net'],
    ]);
    // A organização recém-conectada passa a mostrar os PRs.
    expect(profile.source.provider).toBe('github');

    const post = (body: object, headers: Record<string, string> = { 'x-requested-with': 'fetch' }) =>
      app.inject({ method: 'POST', url: '/auth/active', headers: { cookie, ...headers }, payload: body });
    expect((await post({ connectionId: 'github:acme-gh' }, {})).statusCode).toBe(400);
    expect((await post({ connectionId: 'jira:acme.atlassian.net' })).statusCode).toBe(400);
    expect((await post({ connectionId: '__proto__' })).statusCode).toBe(400);
    expect((await post({ provider: 'github' })).statusCode).toBe(400);
    expect((await post({ connectionId: 'azure-devops:acme' })).statusCode).toBe(204);
    expect((await me(cookie)).source.provider).toBe('azure-devops');
    expect((await post({ connectionId: 'github:acme-gh' })).statusCode).toBe(204);

    profile = await me(cookie);
    expect(profile).toMatchObject({
      organization: 'acme-gh',
      source: { provider: 'github', name: 'GitHub' },
      // Com o GitHub ativo, as tarefas vêm do Jira conectado.
      tracker: { provider: 'jira', name: 'Jira' },
    });
  });

  it('várias organizações por plataforma ficam conectadas ao mesmo tempo', async () => {
    const { app, connect, encrypt, cookieOf, me } = await patServer();
    const cookie = cookieOf(await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) }));
    await connect('azure-devops', { organization: 'fabrikam', encryptedToken: await encrypt(token) }, { cookie });
    await connect('github', { organization: 'acme-labs', encryptedToken: await encrypt(token) }, { cookie });
    await connect('github', { organization: 'globex', encryptedToken: await encrypt(token) }, { cookie });

    let profile = await me(cookie);
    // A última organização conectada passa a mostrar os PRs.
    expect(profile.organization).toBe('globex');
    expect(profile.accounts.map((a: { id?: string; active?: boolean }) => [a.id, a.active])).toEqual([
      ['azure-devops:contoso', false],
      ['azure-devops:fabrikam', false],
      ['github:acme-labs', false],
      ['github:globex', true],
      [undefined, undefined],
    ]);

    const activate = (connectionId: string) =>
      app.inject({ method: 'POST', url: '/auth/active', headers: { cookie, 'x-requested-with': 'fetch' }, payload: { connectionId } });
    expect((await activate('azure-devops:fabrikam')).statusCode).toBe(204);
    profile = await me(cookie);
    expect(profile).toMatchObject({ organization: 'fabrikam', source: { provider: 'azure-devops' } });
  });

  it('reconectar uma organização troca só o token dela, sem mudar a ativa', async () => {
    const { connect, encrypt, cookieOf, me, sessionOf, sessions } = await patServer();
    const cookie = cookieOf(await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) }));
    await connect('azure-devops', { organization: 'fabrikam', encryptedToken: await encrypt(token) }, { cookie });
    const other = 'pat-' + 'b'.repeat(60);
    // Organização não diferencia maiúsculas: é a mesma conexão.
    await connect('azure-devops', { organization: 'Contoso', encryptedToken: await encrypt(other) }, { cookie });

    const profile = await me(cookie);
    expect(profile.organization).toBe('fabrikam');
    expect(profile.accounts.filter((a: { connected: boolean }) => a.connected)).toHaveLength(2);
    expect(sessions.open(sessionOf(cookie).connections!['azure-devops:contoso']!.sealedToken)).toBe(other);
  });

  it('o Jira continua sendo um site por sessão', async () => {
    const { connect, encrypt, cookieOf, me } = await patServer(async () => ({ owner: alex, cloudId: 'c1' }));
    const cookie = cookieOf(await connect('github', { organization: 'acme-gh', encryptedToken: await encrypt(token) }));
    await connect('jira', { site: 'acme.atlassian.net', email: 'alex@example.com', encryptedToken: await encrypt(token) }, { cookie });
    await connect('jira', { site: 'outra.atlassian.net', email: 'alex@example.com', encryptedToken: await encrypt(token) }, { cookie });
    const jira = (await me(cookie)).accounts.filter((a: { provider: string }) => a.provider === 'jira');
    expect(jira).toEqual([expect.objectContaining({ id: 'jira:outra.atlassian.net', active: false })]);
  });

  it('um token recusado derruba só a organização dele', async () => {
    const { app, connect, encrypt, cookieOf, me, rejected } = await patServer();
    const cookie = cookieOf(await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) }));
    await connect('azure-devops', { organization: 'northwind', encryptedToken: await encrypt(token) }, { cookie });
    rejected.add('northwind');

    const board = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(board.statusCode).toBe(401);
    expect(board.json()).toMatchObject({ code: 'connection-expired', connectionId: 'azure-devops:northwind' });
    expect(board.json().message).toContain('northwind');
    expect(board.headers['set-cookie']).toBeUndefined();

    // A sessão continua: o menu de contas abre e mostra qual organização pede reconexão.
    let profile = await me(cookie);
    const northwind = profile.accounts.find((a: { id?: string }) => a.id === 'azure-devops:northwind');
    expect(northwind).toMatchObject({ active: true, expiredAt: expect.any(String) });

    // Não dá para voltar a uma organização expirada sem reconectar; as outras seguem valendo.
    const activate = (connectionId: string) =>
      app.inject({ method: 'POST', url: '/auth/active', headers: { cookie, 'x-requested-with': 'fetch' }, payload: { connectionId } });
    expect((await activate('azure-devops:contoso')).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } })).statusCode).toBe(200);
    expect((await activate('azure-devops:northwind')).statusCode).toBe(400);

    // Reconectar limpa a expiração, sem trocar a organização ativa.
    rejected.delete('northwind');
    await connect('azure-devops', { organization: 'northwind', encryptedToken: await encrypt(token) }, { cookie });
    profile = await me(cookie);
    expect(profile.organization).toBe('contoso');
    expect(profile.accounts.find((a: { id?: string }) => a.id === 'azure-devops:northwind').expiredAt).toBeUndefined();
  });

  it('um 401 do Jira, com o GitHub ativo, não desloga do GitHub', async () => {
    const { app, connect, encrypt, cookieOf, me, rejected } = await patServer(async () => ({ owner: alex, cloudId: 'c1' }));
    const cookie = cookieOf(await connect('github', { organization: 'acme-gh', encryptedToken: await encrypt(token) }));
    await connect('jira', { site: 'acme.atlassian.net', email: 'alex@example.com', encryptedToken: await encrypt(token) }, { cookie });
    rejected.add('acme.atlassian.net');

    const search = await app.inject({ method: 'GET', url: '/api/projects/p-invoicing/work-items?q=login', headers: { cookie } });
    expect(search.statusCode).toBe(401);
    expect(search.json()).toMatchObject({ code: 'connection-expired', connectionId: 'jira:acme.atlassian.net' });
    expect(search.headers['set-cookie']).toBeUndefined();

    // O GitHub segue ativo e funcionando; o Jira aparece pedindo reconexão e deixa de fornecer as tarefas.
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } })).statusCode).toBe(200);
    const profile = await me(cookie);
    expect(profile).toMatchObject({ source: { provider: 'github' }, tracker: null });
    expect(profile.accounts.find((a: { id?: string }) => a.id === 'jira:acme.atlassian.net')).toMatchObject({ expiredAt: expect.any(String) });
  });

  it('a caixa de entrada junta as organizações; uma recusada vira aviso e fica expirada', async () => {
    const { app, connect, encrypt, cookieOf, me, rejected } = await patServer();
    const cookie = cookieOf(await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) }));
    await connect('github', { organization: 'acme-gh', encryptedToken: await encrypt(token) }, { cookie });
    rejected.add('acme-gh');

    const response = await app.inject({ method: 'GET', url: '/api/inbox', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    const inbox = response.json();
    expect(inbox.connections.map((c: { account: string; status: string }) => [c.account, c.status])).toEqual([
      ['contoso', 'ok'],
      ['acme-gh', 'expired'],
    ]);
    expect(inbox.connections[1].expiredAt).toEqual(expect.any(String));
    expect(inbox.items.length).toBeGreaterThan(0);
    expect(inbox.items.every((item: { account: string; column: string }) => item.account === 'contoso' && item.column === 'dependsOnMe')).toBe(true);
    // A recusa marcou a organização, sem derrubar a sessão.
    const profile = await me(cookie);
    expect(profile.accounts.find((a: { id?: string }) => a.id === 'github:acme-gh').expiredAt).toEqual(expect.any(String));
  });

  it('token só de leitura: criar release é recusado sem expirar a organização', async () => {
    const { app, connect, encrypt, cookieOf, me, readOnly } = await patServer();
    const cookie = cookieOf(await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) }));
    readOnly.add('contoso');
    expect((await me(cookie)).capabilities).toEqual({ createRelease: true, linkWorkItems: true });

    const [project] = (await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } })).json();
    const { lanes } = (await app.inject({ method: 'GET', url: `/api/projects/${project.id}/lanes`, headers: { cookie } })).json();
    const lane = lanes.find((candidate: { merged: unknown[] }) => candidate.merged.length > 0);
    const create = () =>
      app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/repositories/${lane.repository.id}/releases`,
        headers: { cookie, 'x-requested-with': 'fetch' },
        payload: { name: 'release/99.0', pullRequestIds: [lane.merged[0].id] },
      });

    const refused = await create();
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'read-only', capability: 'createRelease', connectionId: 'azure-devops:contoso' });
    expect(refused.json().message).toContain('contoso');

    // A organização continua valendo: só criar release fica desabilitado.
    const profile = await me(cookie);
    expect(profile.capabilities).toEqual({ createRelease: false, linkWorkItems: true });
    expect(profile.accounts[0]).toMatchObject({ id: 'azure-devops:contoso', denied: ['createRelease'] });
    expect(profile.accounts[0].expiredAt).toBeUndefined();
    expect((await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } })).statusCode).toBe(200);
    // Da segunda vez, nem chama o provedor.
    readOnly.delete('contoso');
    expect((await create()).statusCode).toBe(403);
  });

  it('as escritas negadas na conexão já desabilitam a ação, antes de chamar o provedor', async () => {
    const { app, connect, encrypt, cookieOf, me } = await patServer(async () => ({ owner: alex, denied: ['linkWorkItems'] }));
    const cookie = cookieOf(await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) }));
    expect((await me(cookie)).capabilities).toEqual({ createRelease: true, linkWorkItems: false });
    const link = await app.inject({
      method: 'PUT',
      url: '/api/projects/p1/repositories/r1/pull-requests/1/work-items/2',
      headers: { cookie, 'x-requested-with': 'fetch' },
    });
    expect(link.statusCode).toBe(403);
    expect(link.json()).toMatchObject({ code: 'read-only', capability: 'linkWorkItems' });
    // Reconectar com um token que escreve libera a ação.
    await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) }, { cookie });
  });

  it('numa escrita, um token vencido de verdade continua expirando a organização', async () => {
    const { app, connect, encrypt, cookieOf, rejected } = await patServer();
    const cookie = cookieOf(await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) }));
    await connect('azure-devops', { organization: 'fabrikam', encryptedToken: await encrypt(token) }, { cookie });
    rejected.add('fabrikam');
    const response = await app.inject({
      method: 'POST',
      url: '/api/projects/p1/repositories/r1/releases',
      headers: { cookie, 'x-requested-with': 'fetch' },
      payload: { name: 'release/99.0', pullRequestIds: [1] },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'connection-expired', connectionId: 'azure-devops:fabrikam' });
  });

  it('a sessão só acaba quando nenhuma organização sobra válida', async () => {
    const { app, connect, encrypt, cookieOf, rejected } = await patServer();
    const cookie = cookieOf(await connect('github', { organization: 'acme-gh', encryptedToken: await encrypt(token) }));
    rejected.add('acme-gh');
    const response = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('unauthenticated');
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('remove uma organização; se era a ativa, outra assume', async () => {
    const { app, connect, encrypt, cookieOf, me } = await patServer();
    const cookie = cookieOf(await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) }));
    await connect('github', { organization: 'acme-gh', encryptedToken: await encrypt(token) }, { cookie });
    const remove = (id: string, headers: Record<string, string> = { 'x-requested-with': 'fetch' }) =>
      app.inject({ method: 'DELETE', url: `/auth/connections/${encodeURIComponent(id)}`, headers: { cookie, ...headers } });

    expect((await remove('github:acme-gh', {})).statusCode).toBe(400);
    expect((await remove('__proto__')).statusCode).toBe(404);
    expect((await remove('github:acme-gh')).statusCode).toBe(204);
    expect(await me(cookie)).toMatchObject({ organization: 'contoso', source: { provider: 'azure-devops' } });

    // Sem nenhuma conexão, a sessão acaba.
    const last = await remove('azure-devops:contoso');
    expect(last.statusCode).toBe(204);
    expect(String(last.headers['set-cookie'])).toMatch(/rm_session=;/);
    expect((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('só o Jira conectado não basta para abrir o board', async () => {
    const { app, connect, encrypt, cookieOf, me } = await patServer(async () => ({ owner: alex, cloudId: 'c1' }));
    const cookie = cookieOf(await connect('jira', { site: 'acme.atlassian.net', email: 'alex@example.com', encryptedToken: await encrypt(token) }));
    expect(await me(cookie)).toMatchObject({ source: null, tracker: null });
    const projects = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(projects.statusCode).toBe(400);
    expect(projects.json().message).toContain('Azure DevOps ou o GitHub');
  });

  it('SESSION_MAX_AGE_DAYS vale para o cookie, e o uso renova a sessão e o cookie', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 0, 1) });
    try {
      const { app, connect, encrypt, cookieOf, sessionOf } = await patServer(undefined, { SESSION_MAX_AGE_DAYS: '7' });
      const login = await connect('azure-devops', { organization: 'contoso', encryptedToken: await encrypt(token) });
      expect(String(login.headers['set-cookie'])).toMatch(/Max-Age=604800/);
      const cookie = cookieOf(login);
      const projects = () => app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
      const day = 24 * 60 * 60 * 1000;

      // Dentro da mesma hora o cookie não é reenviado.
      expect((await projects()).headers['set-cookie']).toBeUndefined();

      // Seis dias depois, ainda válida: o uso estende a sessão por mais 7 dias e reenvia o cookie.
      vi.setSystemTime(Date.now() + 6 * day);
      const renewed = await projects();
      expect(renewed.statusCode).toBe(200);
      expect(String(renewed.headers['set-cookie'])).toMatch(/^rm_session=[^;]{20,};.*Max-Age=604800/);
      expect(sessionOf(cookie).lastSeenAt).toBe(Date.now());

      // Mais seis dias: 12 desde a entrada, mas só 6 desde o último uso.
      vi.setSystemTime(Date.now() + 6 * day);
      expect((await projects()).statusCode).toBe(200);

      // Oito dias parado: vence.
      vi.setSystemTime(Date.now() + 8 * day);
      expect((await projects()).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sem SESSION_SECRET o /auth/mode avisa que as sessões não são persistidas', async () => {
    const config = loadConfig({ AZDO_ORG: 'acme' });
    const sessions = new SessionStore(config.sessionSecret, config.sessionFile);
    const app = await buildServer({ config, sessions, registry: new ConnectionRegistry(config, sessions), webDist: '/nao-existe' });
    expect((await app.inject({ method: 'GET', url: '/auth/mode' })).json()).toMatchObject({ sessionsPersisted: false });
  });

  it('sessão gravada no formato antigo continua valendo', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rm-')), 'sessions.enc');
    const secret = 'x'.repeat(32);
    const store = new SessionStore(secret, file);
    const session = store.create({ mode: 'pat', user: { name: 'Alex' }, ...({ pat: { organization: 'acme', sealedToken: store.seal(token) } } as object) });

    const reloaded = new SessionStore(secret, file).get(session.id)!;
    expect(reloaded.activeConnection).toBe('azure-devops:acme');
    expect(reloaded.connections!['azure-devops:acme']).toMatchObject({ provider: 'azure-devops', account: 'acme' });
    expect(store.open(reloaded.connections!['azure-devops:acme']!.sealedToken)).toBe(token);
  });

  it('sessão gravada com uma conexão por plataforma vira o mapa por organização', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rm-')), 'sessions.enc');
    const secret = 'x'.repeat(32);
    const store = new SessionStore(secret, file);
    const sealedToken = store.seal(token);
    const session = store.create({
      mode: 'pat',
      user: { name: 'Alex' },
      ...({
        connections: {
          'azure-devops': { account: 'Contoso', sealedToken },
          github: { account: 'acme-labs', sealedToken, handle: 'alex' },
          jira: { account: 'acme.atlassian.net', sealedToken, email: 'alex@example.com', cloudId: 'c1' },
        },
        activeSource: 'github',
      } as object),
    });

    const reloaded = new SessionStore(secret, file).get(session.id)!;
    expect(Object.keys(reloaded.connections!)).toEqual(['azure-devops:contoso', 'github:acme-labs', 'jira:acme.atlassian.net']);
    expect(reloaded.connections!['github:acme-labs']).toMatchObject({ provider: 'github', account: 'acme-labs', handle: 'alex' });
    expect(reloaded.activeConnection).toBe('github:acme-labs');
    expect('activeSource' in reloaded).toBe(false);
  });
});
