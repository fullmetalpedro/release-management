import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AZURE_DEVOPS_SCOPE, EntraIdentityProvider } from '../src/adapters/entra/identityProvider.ts';
import type { PatValidator } from '../src/adapters/http/patProviders.ts';
import { buildServer } from '../src/adapters/http/server.ts';
import { MemorySourceControl, MemoryWorkTracking } from '../src/adapters/memory/memoryAdapters.ts';
import { createWorld } from '../src/adapters/memory/world.ts';
import { SessionStore } from '../src/adapters/session/sessionStore.ts';
import { loadConfig } from '../src/config.ts';
import { NotAuthenticatedError } from '../src/core/domain/errors.ts';
import type { IdentityProvider } from '../src/core/ports/identityProvider.ts';
import { ConnectionRegistry } from '../src/registry.ts';

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
          id_token: idToken({ name: 'Pedro Carlo', preferred_username: 'pedro.carlo@muralis.com.br' }),
        });
      },
      () => 1_000,
    );
    const result = await provider.completeLogin('codigo', 'verificador');

    expect(result.profile).toEqual({ name: 'Pedro Carlo', email: 'pedro.carlo@muralis.com.br' });
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
      user: { name: 'Pedro Carlo' },
      tokens: { accessToken: 'at-secreto', refreshToken: 'rt-secreto', expiresAt: 1 },
    });

    expect(readFileSync(file).toString('latin1')).not.toMatch(/secreto|Pedro/);
    expect(new SessionStore(secret, file).get(session.id)?.tokens?.refreshToken).toBe('rt-secreto');
    expect(new SessionStore('y'.repeat(32), file).get(session.id)).toBeUndefined();
  });
});

describe('configuração', () => {
  it('sem nada configurado só há token pessoal; app registration exige o resto; demonstração é opcional', () => {
    expect(loadConfig({})).toMatchObject({ demo: false, organization: '', sessionFile: undefined });
    expect(loadConfig({}).entra).toBeUndefined();
    expect(loadConfig({ AUTH_MODE: 'demo' })).toMatchObject({ demo: true, organization: 'demo' });
    expect(loadConfig({ SESSION_SECRET: 'x'.repeat(32) }).sessionFile).toMatch(/sessions\.enc$/);
    expect(() => loadConfig({ SESSION_SECRET: 'curto' })).toThrow('32 caracteres');
    expect(() => loadConfig({ ENTRA_CLIENT_ID: 'c' })).toThrow('SESSION_SECRET');
    const config = loadConfig({
      ENTRA_CLIENT_ID: 'c',
      ENTRA_TENANT_ID: 't',
      ENTRA_CLIENT_SECRET: 's',
      AZDO_ORG: 'muralis',
      SESSION_SECRET: 'x'.repeat(32),
      AZDO_PROJECTS: 'GetNota, Lead Comex ,Jane',
      APP_URL: 'https://rm.muralis.com.br/',
    });
    expect(config).toMatchObject({
      demo: false,
      organization: 'muralis',
      projects: ['GetNota', 'Lead Comex', 'Jane'],
      entra: { redirectUri: 'https://rm.muralis.com.br/auth/microsoft/callback' },
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
    const { app, cookie, login } = await demoServer({ AZDO_PROJECTS: 'GetNota,Lead Comex,Jane' });
    expect(login.statusCode).toBe(302);
    expect(String(login.headers['set-cookie'])).toMatch(/HttpOnly/i);

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ user: { name: 'Pedro Carlo' }, demo: true });
    expect(me.json().accounts.filter((a: { connected: boolean }) => a.connected)).toEqual([
      { provider: 'azure-devops', connected: true, active: true, handle: 'pedro.carlo@example.com' },
    ]);

    const projects = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(projects.json().map((p: { name: string; openPullRequests: number }) => [p.name, p.openPullRequests])).toEqual([
      ['GetNota', 11],
      ['Lead Comex', 4],
      ['Jane', 7],
    ]);

    const board = await app.inject({ method: 'GET', url: '/api/projects/p-getnota/board', headers: { cookie } });
    expect(board.json().columns.dependsOnMe).toHaveLength(4);
  });

  it('exige o cabeçalho anti-CSRF nas escritas e devolve 409 no conflito', async () => {
    const { app, cookie } = await demoServer({ DEMO_FAIL: 'conflict:1291' });
    const url = '/api/projects/p-getnota/repositories/r-getnota-api/releases';
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
    const board = await app.inject({ method: 'GET', url: '/api/projects/p-getnota/board', headers: { cookie } });
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
      AZDO_ORG: 'muralis',
      SESSION_SECRET: 'x'.repeat(32),
      DATA_DIR: mkdtempSync(join(tmpdir(), 'rm-')),
    });
    const identityProvider: IdentityProvider = {
      beginLogin: () => ({ url: 'https://login.example/authorize', state: 'estado', codeVerifier: 'verificador' }),
      completeLogin: async (code, verifier) => {
        expect([code, verifier]).toEqual(['codigo', 'verificador']);
        return { tokens: { accessToken: 'at', expiresAt: Date.now() + 3_600_000 }, profile: { name: 'Pedro Carlo' } };
      },
      refresh: async () => ({ accessToken: 'at', expiresAt: 0 }),
    };
    const sessions = new SessionStore(config.sessionSecret);
    const app = await buildServer({ config, sessions, registry: new ConnectionRegistry(config, sessions, identityProvider), identityProvider, webDist: '/nao-existe' });

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
    expect(me.json()).toMatchObject({ user: { name: 'Pedro Carlo' }, demo: false, organization: 'muralis' });
  });
});

describe('conexão por token pessoal', () => {
  const env = { SESSION_SECRET: 'x'.repeat(32), AZDO_ORG: 'muralisti' };
  const token = 'pat-' + 'a'.repeat(60);
  const pedro = { id: 'u1', name: 'Pedro Carlo', email: 'pedro.carlo@muralis.com.br' };

  async function patServer(validatePat: PatValidator = async () => ({ owner: pedro })) {
    const file = join(mkdtempSync(join(tmpdir(), 'rm-')), 'sessions.enc');
    const config = { ...loadConfig(env), sessionFile: file };
    const sessions = new SessionStore(config.sessionSecret, file);
    // Os adapters reais chamariam os provedores; com uma plataforma ativa, os testes usam os de memória.
    const registry = new ConnectionRegistry(config, sessions);
    const real = registry.for.bind(registry);
    const world = createWorld();
    registry.for = (session) =>
      session.activeSource ? { sourceControl: new MemorySourceControl(world), workTracking: new MemoryWorkTracking(world) } : real(session);
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
    return { app, sessions, file, encrypt, connect, cookieOf, me };
  }

  it('está sempre disponível; sem app registration o login com Microsoft é anunciado como indisponível', async () => {
    const { app } = await patServer();
    expect((await app.inject({ method: 'GET', url: '/auth/mode' })).json()).toEqual({
      microsoft: false,
      pat: true,
      demo: false,
      defaultOrganization: 'muralisti',
    });
    const login = await app.inject({ method: 'GET', url: '/auth/microsoft/login' });
    expect(login.headers.location).toBe('http://localhost:5173/login?erro=indisponivel');
  });

  it('recebe o token cifrado, valida no provedor e guarda selado', async () => {
    const seen: unknown[] = [];
    const { sessions, file, encrypt, connect, cookieOf, me } = await patServer(async (provider, input) => {
      seen.push([provider, input.account, input.token]);
      return { owner: pedro };
    });

    const encryptedToken = await encrypt(token);
    expect(encryptedToken).not.toContain(token);
    const response = await connect('azure-devops', { organization: 'muralisti', encryptedToken });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ provider: 'azure-devops', account: 'muralisti', user: { name: 'Pedro Carlo', email: 'pedro.carlo@muralis.com.br' } });
    expect(response.body).not.toContain(token);
    expect(seen).toEqual([['azure-devops', 'muralisti', token]]);

    const cookie = cookieOf(response);
    expect(cookie).not.toContain(token);
    const profile = await me(cookie);
    expect(profile).toMatchObject({
      mode: 'pat',
      organization: 'muralisti',
      source: { provider: 'azure-devops', name: 'Azure DevOps' },
      tracker: { provider: 'azure-devops', name: 'Azure DevOps' },
    });
    // Azure DevOps sempre primeiro na lista de contas.
    expect(profile.accounts).toEqual([
      { provider: 'azure-devops', connected: true, active: true, handle: 'pedro.carlo@muralis.com.br', account: 'muralisti' },
      { provider: 'github', connected: false },
      { provider: 'jira', connected: false },
    ]);
    expect(JSON.stringify(profile)).not.toContain(token);

    // Nem o arquivo de sessões nem o objeto em memória carregam o token em claro.
    expect(readFileSync(file).toString('latin1')).not.toContain(token);
    const [, sessionId] = decodeURIComponent(cookie).match(/rm_session=([^.]+)\./)!;
    const stored = sessions.get(sessionId)!;
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(sessions.open(stored.connections!['azure-devops']!.sealedToken)).toBe(token);
  });

  it('token recusado não cria sessão', async () => {
    const { connect, encrypt } = await patServer(async () => {
      throw new NotAuthenticatedError();
    });
    const response = await connect('github', { organization: 'muralis', encryptedToken: await encrypt(token) });
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
    expect((await connect('jira', { site: 'muralis.atlassian.net', email: 'sem-arroba', encryptedToken })).statusCode).toBe(400);
    expect((await connect('azure-devops', { organization: 'muralisti', encryptedToken: Buffer.from(token).toString('base64') })).statusCode).toBe(400);
    expect((await connect('gitlab', { organization: 'muralis', encryptedToken })).statusCode).toBe(404);
    const forged = await app.inject({ method: 'POST', url: '/auth/pat/azure-devops', payload: { organization: 'muralisti', encryptedToken } });
    expect(forged.statusCode).toBe(400);
  });

  it('as plataformas se somam na mesma sessão, e a ativa pode ser trocada', async () => {
    const { app, connect, encrypt, cookieOf, me } = await patServer(async (provider) => ({
      owner: provider === 'github' ? { id: 'gh1', name: 'pedro-gh', email: 'fullmetalpedro' } : provider === 'jira' ? { id: 'j1', name: 'Pedro Jira', email: 'pedro@muralis.com.br' } : pedro,
      cloudId: provider === 'jira' ? 'cloud-123' : undefined,
    }));
    const first = await connect('azure-devops', { organization: 'muralisti', encryptedToken: await encrypt(token) });
    const cookie = cookieOf(first);

    const github = await connect('github', { organization: 'muralis-gh', encryptedToken: await encrypt(token) }, { cookie });
    expect(github.statusCode).toBe(200);
    expect(github.headers['set-cookie']).toBeUndefined();
    await connect('jira', { site: 'https://Muralis.atlassian.net/jira', email: 'pedro@muralis.com.br', encryptedToken: await encrypt(token) }, { cookie });

    let profile = await me(cookie);
    expect(profile.accounts.map((a: { provider: string; connected: boolean; active?: boolean; account?: string }) => [a.provider, a.connected, a.active, a.account])).toEqual([
      ['azure-devops', true, true, 'muralisti'],
      ['github', true, false, 'muralis-gh'],
      ['jira', true, false, 'muralis.atlassian.net'],
    ]);
    expect(profile.source.provider).toBe('azure-devops');

    const post = (body: object, headers: Record<string, string> = { 'x-requested-with': 'fetch' }) =>
      app.inject({ method: 'POST', url: '/auth/active', headers: { cookie, ...headers }, payload: body });
    expect((await post({ provider: 'github' }, {})).statusCode).toBe(400);
    expect((await post({ provider: 'jira' })).statusCode).toBe(400);
    expect((await post({ provider: 'github' })).statusCode).toBe(204);

    profile = await me(cookie);
    expect(profile).toMatchObject({
      organization: 'muralis-gh',
      source: { provider: 'github', name: 'GitHub' },
      // Com o GitHub ativo, as tarefas vêm do Jira conectado.
      tracker: { provider: 'jira', name: 'Jira' },
    });
  });

  it('trocar o token de uma plataforma mantém a sessão e as outras conexões', async () => {
    const { connect, encrypt, cookieOf, me } = await patServer();
    const cookie = cookieOf(await connect('azure-devops', { organization: 'muralisti', encryptedToken: await encrypt(token) }));
    await connect('github', { organization: 'muralis-gh', encryptedToken: await encrypt(token) }, { cookie });
    await connect('azure-devops', { organization: 'outra-org', encryptedToken: await encrypt(token) }, { cookie });

    const profile = await me(cookie);
    expect(profile.organization).toBe('outra-org');
    expect(profile.accounts.filter((a: { connected: boolean }) => a.connected)).toHaveLength(2);
  });

  it('só o Jira conectado não basta para abrir o board', async () => {
    const { app, connect, encrypt, cookieOf, me } = await patServer(async () => ({ owner: pedro, cloudId: 'c1' }));
    const cookie = cookieOf(await connect('jira', { site: 'muralis.atlassian.net', email: 'pedro@muralis.com.br', encryptedToken: await encrypt(token) }));
    expect(await me(cookie)).toMatchObject({ source: null, tracker: null });
    const projects = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    expect(projects.statusCode).toBe(400);
    expect(projects.json().message).toContain('Azure DevOps ou o GitHub');
  });

  it('sessão gravada no formato antigo continua valendo', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rm-')), 'sessions.enc');
    const secret = 'x'.repeat(32);
    const store = new SessionStore(secret, file);
    const session = store.create({ mode: 'pat', user: { name: 'Pedro' }, ...({ pat: { organization: 'muralisti', sealedToken: store.seal(token) } } as object) });

    const reloaded = new SessionStore(secret, file).get(session.id)!;
    expect(reloaded.activeSource).toBe('azure-devops');
    expect(reloaded.connections!['azure-devops']!.account).toBe('muralisti');
    expect(store.open(reloaded.connections!['azure-devops']!.sealedToken)).toBe(token);
  });
});
