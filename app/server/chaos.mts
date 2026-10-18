// Teste de caos exploratório: sobe o servidor de verdade (HTTP) em modo demonstração e em modo token (com o
// validador de token trocado por um falso) e ataca tudo. Invariantes: nenhum 5xx, nenhum vazamento de detalhe
// interno, cabeçalhos de segurança em toda resposta, e as regras de sessão e de uso único valendo sob concorrência.
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';
import net from 'node:net';
import { buildServer } from './src/adapters/http/server.ts';
import { MemorySourceControl, MemoryWorkTracking } from './src/adapters/memory/memoryAdapters.ts';
import { createWorld } from './src/adapters/memory/world.ts';
import { SessionStore } from './src/adapters/session/sessionStore.ts';
import { loadConfig } from './src/config.ts';
import { ConnectionRegistry } from './src/registry.ts';

const findings = new Map<string, { count: number; sample: string }>();
const note = (kind: string, sample: string) => {
  const entry = findings.get(kind) ?? { count: 0, sample };
  entry.count += 1;
  findings.set(kind, entry);
};
let requests = 0;

const LEAK = /\bat .+\(.+:\d+:\d+\)|node_modules|[A-Z]:\\\\Users|\/src\/adapters|TypeError|ReferenceError|SyntaxError|ECONN|stack/i;
const HEADERS = ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy'];

async function hit(base: string, label: string, path: string, init: RequestInit & { expect?: number[] } = {}) {
  requests += 1;
  let response: Response;
  try {
    response = await fetch(base + path, { redirect: 'manual', ...init });
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    note('conexão derrubada · ' + label + ' · ' + (cause?.code ?? cause?.message ?? (error as Error).message), (init.method ?? 'GET') + ' ' + path.slice(0, 80));
    return undefined;
  }
  const text = await response.text();
  const where = `${label} ${init.method ?? 'GET'} ${path.slice(0, 90)} -> ${response.status}`;
  if (response.status >= 500) note(`status ${response.status}`, `${where} ${text.slice(0, 160)}`);
  if (LEAK.test(text)) note('vazamento de detalhe interno', `${where} ${text.slice(0, 200)}`);
  for (const header of HEADERS) if (!response.headers.has(header)) note('sem cabeçalho ' + header + ' · ' + label + ' · ' + response.status, where);
  if (init.expect && !init.expect.includes(response.status)) note('status inesperado', `${where} (esperado ${init.expect.join('/')}) ${text.slice(0, 120)}`);
  return { status: response.status, text, headers: response.headers };
}

const HOSTILE = [
  '', ' ', '0', '-1', '1e309', 'NaN', 'null', 'undefined', 'true', '[]', '{}', '__proto__', 'constructor', 'toString',
  '..', '../..', '..%2f..%2f', '%2e%2e%2f', '%252e%252e', '..%5c', '%00', 'a%00b', '%0d%0aSet-Cookie:x=1', '%E0%A4%A', '%',
  'a'.repeat(5000), '😀'.repeat(200), "' OR 1=1--", '"><script>alert(1)</script>', '${7*7}', '{{7*7}}', '%7B%7B7*7%7D%7D',
  'p-invoicing', 'r-invoicing-api', 'p-invoicing/../p-scheduler', 'http://evil.com', '//evil.com', '?x=1', '#x', ';x', 'a b', 'a+b', 'ａ',
];
const BODIES: unknown[] = [
  undefined, null, 0, '', 'x', [], {}, { name: null }, { name: 1, pullRequestIds: 'x' }, { name: 'release/9.9', pullRequestIds: [1e308] },
  { name: 'release/9.9', pullRequestIds: [1295, 1295, 1295] }, { name: 'release/9.9', pullRequestIds: [999999] },
  { name: 'release/9.9', pullRequestIds: [1.5] }, { name: 'release/9.9', pullRequestIds: ['1295'] }, { name: 'release/9.9', pullRequestIds: [[1295]] },
  { name: 'release/../../x', pullRequestIds: [1295] }, { name: 'a'.repeat(10000), pullRequestIds: [1295] }, { name: 'release/2.15', pullRequestIds: [1295] },
  { name: ' release/9.9 ', pullRequestIds: [1295] }, { name: 'release/9.9\u0000', pullRequestIds: [1295] }, { name: 'release/9.9', pullRequestIds: Array.from({ length: 5000 }, (_, i) => i + 1) },
  { __proto__: { admin: true }, name: 'release/9.9', pullRequestIds: [1295] }, JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"name":"release/9.9","pullRequestIds":[1295]}'),
  { connectionId: '__proto__' }, { connectionId: 'constructor' }, { connectionId: ['github:acme'] }, { connectionId: { toString: 1 } },
];

async function start(env: NodeJS.ProcessEnv, extra: Partial<Parameters<typeof buildServer>[0]> = {}) {
  const loaded = loadConfig(env);
  const config = { ...loaded, demoFaults: { ...loaded.demoFaults, latencyMs: 0 } };
  const sessions = new SessionStore(config.sessionSecret);
  const registry = new ConnectionRegistry(config, sessions);
  if (!config.demo) {
    const world = createWorld();
    const real = registry.for.bind(registry);
    registry.for = (session) => (session.activeConnection ? { sourceControl: new MemorySourceControl(world), workTracking: new MemoryWorkTracking(world) } : real(session));
  }
  const app = await buildServer({ config, sessions, registry, webDist: '/nao-existe', ...extra });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as net.AddressInfo;
  return { app, sessions, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

// Rajadas em lotes: milhares de conexões abertas no mesmo instante esbarram na fila de conexões do sistema
// operacional (ECONNREFUSED), o que diria mais sobre a máquina do teste do que sobre o servidor.
async function inBatches<T>(count: number, size: number, run: (index: number) => Promise<T>): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < count; start += size) {
    results.push(...(await Promise.all(Array.from({ length: Math.min(size, count - start) }, (_, i) => run(start + i)))));
  }
  return results;
}

const cookieOf = (headers: Headers) => headers.getSetCookie().map((c) => c.split(';')[0]!).find((c) => c.startsWith('rm_session=') && c.length > 30);
const write = (cookie: string, json = true) => ({ cookie, 'x-requested-with': 'fetch', ...(json ? { 'content-type': 'application/json' } : {}) });

// ============ Demonstração ============
{
  const { app, sessions, base, port } = await start({ AUTH_MODE: 'demo' });
  const login = await hit(base, 'demo', '/auth/microsoft/login');
  const cookie = cookieOf(login!.headers)!;
  const P = '/api/projects/p-invoicing';
  const R = `${P}/repositories/r-invoicing-api`;

  // --- Sem sessão, toda rota de API responde 401 ---
  for (const path of ['/api/me', '/api/projects', `${P}/board`, `${P}/lanes`, `${R}/lane`, `${R}/release`, `${P}/work-items?q=a`, '/api/avatars/x', '/api/nada']) {
    await hit(base, 'sem sessão', path, { expect: path === '/api/nada' ? [404] : [401] });
  }
  // --- Cookies forjados ---
  for (const forged of ['rm_session=x', `rm_session=${'a'.repeat(9000)}`, `${cookie}x`, cookie.replace(/\.[^.]*$/, '.assinaturafalsa'), cookie.split('.')[0]!, 'rm_session=', 'rm_session=%00', `${cookie}; rm_session=x`, `rm_session=x; ${cookie}`]) {
    const response = await hit(base, 'cookie forjado', '/api/me', { headers: { cookie: forged } });
    if (response?.status === 200 && forged !== `${cookie}; rm_session=x`) note('cookie forjado aceito', forged.slice(0, 60));
  }

  // --- Parâmetros hostis em toda rota ---
  const routes = (v: string) => [
    `/api/projects/${v}/board`, `/api/projects/${v}/lanes`, `/api/projects/${v}/work-items?q=a`, `${P}/repositories/${v}/lane`, `${P}/repositories/${v}/release`,
    `${R}/release?branch=${v}`, `${P}/work-items?q=${v}`, `/api/avatars/${v}`, `${P}/work-items?q=a&q=${v}`, `${P}/work-items?q[a]=${v}`, `${R}/release?branch[]=${v}&branch[]=x`,
  ];
  for (const value of HOSTILE) {
    for (const path of routes(value)) await hit(base, 'parâmetro hostil', path, { headers: { cookie } });
    for (const method of ['PUT', 'DELETE']) {
      await hit(base, 'vínculo hostil', `${R}/pull-requests/${value || '%20'}/work-items/1`, { method, headers: write(cookie, false) });
      await hit(base, 'vínculo hostil', `${R}/pull-requests/1274/work-items/${value || '%20'}`, { method, headers: write(cookie, false) });
    }
  }

  // --- Corpos hostis ---
  for (const body of BODIES) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    await hit(base, 'corpo hostil', `${R}/releases`, { method: 'POST', headers: write(cookie), body: payload });
  }
  for (const raw of ['{', '{"name":', 'null', '[]', '"x"', '\u0000', '{"a":'.repeat(2000) + '1' + '}'.repeat(2000), 'a'.repeat(2_000_000)]) {
    await hit(base, 'corpo cru', `${R}/releases`, { method: 'POST', headers: write(cookie), body: raw });
  }
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/xml', '', 'application/json; charset=utf-7']) {
    await hit(base, 'content-type', `${R}/releases`, { method: 'POST', headers: { ...write(cookie, false), 'content-type': type }, body: '{"name":"release/9.9","pullRequestIds":[1295]}' });
  }
  if (({} as Record<string, unknown>).polluted !== undefined) note('prototype pollution', 'Object.prototype.polluted definido');

  // --- CSRF: escrita sem o cabeçalho ---
  for (const [method, path] of [['POST', `${R}/releases`], ['PUT', `${R}/pull-requests/1274/work-items/48125`], ['DELETE', `${R}/pull-requests/1274/work-items/48125`], ['POST', '/auth/logout']] as const) {
    const response = await hit(base, 'csrf', path, { method, headers: { cookie, 'content-type': 'application/json' }, body: method === 'POST' ? '{"name":"release/9.9","pullRequestIds":[1295]}' : undefined });
    if (response && response.status < 400) note('escrita aceita sem cabeçalho anti-CSRF', `${method} ${path}`);
  }
  // --- Métodos inesperados ---
  for (const method of ['PATCH', 'OPTIONS', 'HEAD', 'PROPFIND']) {
    for (const path of ['/api/me', `${R}/releases`, '/auth/mode', '/auth/logout']) await hit(base, 'método', path, { method, headers: write(cookie, false) });
  }

  // --- Concorrência: duas criações da mesma release ---
  const created = await Promise.all(
    Array.from({ length: 12 }, () => hit(base, 'corrida', `${R}/releases`, { method: 'POST', headers: write(cookie), body: JSON.stringify({ name: 'release/2.16', pullRequestIds: [1295, 1294] }) })),
  );
  const wins = created.filter((r) => r?.status === 201).length;
  if (wins !== 1) note('corrida na criação de release', `${wins} criações com sucesso para o mesmo nome (esperado 1): ${created.map((r) => r?.status).join(',')}`);

  // --- Concorrência: vincular e desvincular a mesma task ---
  const linkPath = `${R}/pull-requests/1274/work-items/48125`;
  const links = await Promise.all(Array.from({ length: 30 }, (_, i) => hit(base, 'corrida vínculo', linkPath, { method: i % 2 ? 'DELETE' : 'PUT', headers: write(cookie, false) })));
  if (links.some((r) => r && r.status >= 500)) note('corrida no vínculo', links.map((r) => r?.status).join(','));

  // --- Carga: 300 leituras em paralelo ---
  const started = Date.now();
  const burst = await inBatches(1200, 100, (i) => hit(base, 'rajada', [`${P}/board`, `${P}/lanes`, `${R}/release`, '/api/me'][i % 4]!, { headers: { cookie } }));
  if (burst.some((r) => !r || r.status !== 200)) note('rajada com falha', [...new Set(burst.map((r) => r?.status))].join(','));
  console.log(`rajada de 1200 leituras (100 por vez): ${Date.now() - started} ms`);

  // --- Memória: cache de fotos e sessões ---
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  await inBatches(6000, 100, (i) => hit(base, 'fotos', `/api/avatars/chave-${i}-${'x'.repeat(300)}`, { headers: { cookie } }));
  globalThis.gc?.();
  const grown = (process.memoryUsage().heapUsed - before) / 1e6;
  console.log(`heap depois de 6000 chaves de foto: +${grown.toFixed(1)} MB`);

  // --- Limite de tentativas: não pode ser driblado com X-Forwarded-For ---
  let limited = 0;
  for (let i = 0; i < 80; i++) {
    const response = await hit(base, 'limite', '/auth/microsoft/login', { headers: { 'x-forwarded-for': `10.0.0.${i}` } });
    if (response?.status === 429) limited += 1;
  }
  if (limited === 0) note('limite de tentativas driblado com X-Forwarded-For', '80 entradas sem nenhum 429');
  const sessionCount = (sessions as unknown as { sessions: Map<string, unknown> }).sessions.size;
  console.log(`sessões de demonstração depois de 80 entradas sem cookie: ${sessionCount}`);

  // --- Sessão encerrada não volta ---
  await hit(base, 'logout', '/auth/logout', { method: 'POST', headers: write(cookie, false), expect: [204] });
  await hit(base, 'cookie de sessão encerrada', '/api/me', { headers: { cookie }, expect: [401] });

  // --- Requisição crua malformada e conexão lenta ---
  const raw = (payload: string, waitMs = 1500) =>
    new Promise<string>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data || 'erro'));
      socket.write(payload);
      setTimeout(() => {
        resolve(data || '(sem resposta, conexão ainda aberta)');
        socket.destroy();
      }, waitMs);
    });
  const smuggle = await raw('POST /auth/logout HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /api/me HTTP/1.1\r\nHost: x\r\n\r\n');
  if (/HTTP\/1\.1 200/.test(smuggle)) note('request smuggling', smuggle.slice(0, 120));
  const longHeader = await raw(`GET /auth/mode HTTP/1.1\r\nHost: x\r\nX-A: ${'a'.repeat(200_000)}\r\n\r\n`);
  if (longHeader.includes(' 200 ')) note('cabeçalho gigante aceito', longHeader.slice(0, 80));
  const slow = await raw('GET /auth/mode HTTP/1.1\r\nHost: x\r\n', 4000);
  console.log(`conexão lenta (cabeçalho nunca termina) depois de 4 s: ${slow.slice(0, 60).replace(/\r\n/g, ' ')}`);
  console.log(`timeouts do servidor: headers ${app.server.headersTimeout} ms, request ${app.server.requestTimeout} ms, keepAlive ${app.server.keepAliveTimeout} ms, connection ${app.server.timeout} ms`);

  await app.close();
}

// ============ Token ============
{
  let validations = 0;
  const { app, base } = await start(
    { SESSION_SECRET: 'x'.repeat(32), AZDO_ORG: 'acme' },
    {
      authAttemptsPerMinute: 1_000_000,
      validatePat: async () => {
        validations += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { owner: { id: 'u1', name: 'Alex', email: 'p@m.com' }, cloudId: '11111111-2222-3333-4444-555555555555' };
      },
    },
  );
  const envelope = async (token: string, nonceOverride?: string) => {
    const { publicKey, nonce } = JSON.parse((await hit(base, 'chave', '/auth/pat/key'))!.text);
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const sealed = Buffer.concat([cipher.update(JSON.stringify({ nonce: nonceOverride ?? nonce, token })), cipher.final()]);
    const wrapped = publicEncrypt({ key: createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
    return Buffer.concat([wrapped, iv, sealed, cipher.getAuthTag()]).toString('base64');
  };
  const connect = (provider: string, body: unknown, headers: Record<string, string> = {}) =>
    hit(base, 'token', `/auth/pat/${provider}`, { method: 'POST', headers: { 'x-requested-with': 'fetch', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const token = 'pat-' + 'a'.repeat(60);

  // --- Mesmo envelope enviado 15 vezes ao mesmo tempo: só um pode valer ---
  const shared = await envelope(token);
  const replays = await Promise.all(Array.from({ length: 15 }, () => connect('azure-devops', { organization: 'acme', encryptedToken: shared })));
  const accepted = replays.filter((r) => r?.status === 200).length;
  if (accepted !== 1) note('envelope reaproveitado em corrida', `${accepted} aceitos de 15 (esperado 1)`);

  // --- Envelopes malformados ---
  const good = Buffer.from(await envelope(token), 'base64');
  const mutants = ['', 'x', '====', good.subarray(0, 100).toString('base64'), good.subarray(0, 256).toString('base64'), good.subarray(0, 268).toString('base64'), Buffer.alloc(300).toString('base64'), randomBytes(600).toString('base64'), 'A'.repeat(900_000), good.toString('hex'), good.toString('base64') + 'AAAA'];
  for (let i = 0; i < 24; i++) {
    const flipped = Buffer.from(good);
    flipped[Math.floor(Math.random() * flipped.length)]! ^= 1 << (i % 8);
    mutants.push(flipped.toString('base64'));
  }
  for (const mutant of mutants) {
    const response = await connect('azure-devops', { organization: 'acme', encryptedToken: mutant });
    if (response?.status === 200) note('envelope adulterado aceito', mutant.slice(0, 40));
  }
  for (const encryptedToken of [null, 1, [], {}, true]) await connect('azure-devops', { organization: 'acme', encryptedToken });
  // --- Token dentro do envelope com conteúdo hostil ---
  for (const inner of ['', ' ', 'a'.repeat(19), 'a'.repeat(401), 'a'.repeat(5000), 'tok\r\nX-Injected: 1' + 'a'.repeat(30), 'tok\u0000' + 'a'.repeat(30), '😀'.repeat(30)]) {
    const response = await connect('azure-devops', { organization: 'acme', encryptedToken: await envelope(inner) });
    if (response?.status === 200 && /[\r\n\u0000]/.test(inner)) note('token com caractere de controle aceito', JSON.stringify(inner.slice(0, 30)));
  }
  // --- Contas hostis ---
  for (const provider of ['azure-devops', 'github', 'jira', 'gitlab', '__proto__', 'constructor', '..%2f', 'a'.repeat(3000)]) {
    for (const value of HOSTILE.slice(0, 30)) {
      const response = await connect(provider, { organization: value, site: value, email: value, encryptedToken: 'x' });
      if (response?.status === 200) note('conta hostil aceita', `${provider} ${value.slice(0, 40)}`);
    }
    for (const account of [null, 1, [], { organization: {} }, { organization: ['a'] }, { site: 'acme.atlassian.net', email: { $ne: '' } }]) await connect(provider, account);
  }
  // --- Trocar a plataforma ativa com valores hostis ---
  const session = cookieOf((await connect('azure-devops', { organization: 'acme', encryptedToken: await envelope(token) }))!.headers)!;
  for (const body of BODIES) await hit(base, 'ativa', '/auth/active', { method: 'POST', headers: write(session), body: body === undefined ? undefined : JSON.stringify(body) });
  const me = await hit(base, 'me', '/api/me', { headers: { cookie: session }, expect: [200] });
  if (me && me.text.includes(token)) note('token devolvido ao cliente', '/api/me');
  // --- Nonces pedidos em massa não podem crescer sem limite ---
  for (let i = 0; i < 40; i++) await hit(base, 'chave em massa', '/auth/pat/key');
  console.log(`validações no provedor disparadas: ${validations}`);
  await app.close();
}

console.log(`\n${requests} requisições`);
if (findings.size === 0) console.log('nenhum achado');
for (const [kind, { count, sample }] of [...findings].sort((a, b) => b[1].count - a[1].count)) console.log(`\n[${count}x] ${kind}\n    ex.: ${sample}`);
process.exit(0);
