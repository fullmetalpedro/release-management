import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config.ts';
import {
  CherryPickConflictError,
  LocalizedError,
  NotAuthenticatedError,
  NotFoundError,
  ProviderUnavailableError,
  RateLimitedError,
  ValidationError,
} from '../../core/domain/errors.ts';
import type { IdentityProvider } from '../../core/ports/identityProvider.ts';
import { getBoard } from '../../core/usecases/board.ts';
import { listProjects } from '../../core/usecases/projects.ts';
import { getReleaseDetails } from '../../core/usecases/releaseDetails.ts';
import { createRelease, getReleaseLane, getReleaseLanes } from '../../core/usecases/releaseLane.ts';
import { linkWorkItem, searchWorkItems, unlinkWorkItem } from '../../core/usecases/workItems.ts';
import type { ConnectionRegistry } from '../../registry.ts';
import {
  createPatValidator,
  parseAccount,
  PAT_PROVIDERS,
  PROVIDER_LABELS,
  type PatValidation,
  type PatValidator,
} from './patProviders.ts';
import { PatTransport } from './patTransport.ts';
import { ALEX } from '../memory/world.ts';
import type { PatProvider, Session, SessionStore, SourceProvider } from '../session/sessionStore.ts';
import { localeFrom, msg, render } from '../../i18n.ts';

const SESSION_COOKIE = 'rm_session';
const OAUTH_COOKIE = 'rm_oauth';

export interface ServerDeps {
  config: AppConfig;
  sessions: SessionStore;
  registry: ConnectionRegistry;
  identityProvider?: IdentityProvider;
  webDist?: string;
  validatePat?: PatValidator;
  // Tentativas de entrada por minuto, por IP.
  authAttemptsPerMinute?: number;
}

const isSource = (provider: PatProvider): provider is SourceProvider => provider !== 'jira';

const MAX_RELEASE_PULL_REQUESTS = 100;
const AVATAR_TTL_MS = 6 * 60 * 60 * 1000;
// "Sem foto" pode ser só uma falha passageira do provedor: vale por pouco tempo.
const MISSING_AVATAR_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_AVATARS = 2_000;
const MAX_AVATAR_KEY_LENGTH = 420;
// SVG fica de fora: servido da nossa origem, ele poderia rodar script.
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Ids de projeto, repositório e afins viram segmento de URL do provedor. Os adapters codificam o segmento; aqui
// barramos de saída o que nunca é um id legítimo (separadores de caminho, "..", caracteres de controle).
const isSafeSegment = (value: string) =>
  value.length > 0 && value.length <= 200 && value !== '.' && value !== '..' && !/[\/\\?#%\u0000-\u001f\u007f]/.test(value);

const isPositiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data:",
  // O Tailwind e o sonner aplicam estilos inline.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { config, sessions, registry, identityProvider } = deps;
  const secure = config.appUrl.startsWith('https://');
  const secureHeaders = (reply: FastifyReply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    if (secure) reply.header('Strict-Transport-Security', 'max-age=31536000');
  };
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'warn' },
    trustProxy: config.trustProxy,
    // As chaves de foto do Azure DevOps são descritores longos.
    routerOptions: { maxParamLength: 500 },
    // Uma requisição que não termina de chegar não segura a conexão para sempre.
    requestTimeout: 30_000,
    // URL malformada ou parâmetro longo demais são barrados antes das rotas e dos hooks: a resposta sai daqui,
    // com os mesmos cabeçalhos e o mesmo formato das outras.
    frameworkErrors: (error, request, rawReply) => {
      const reply = rawReply as FastifyReply;
      secureHeaders(reply);
      const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 400;
      const message = render(msg('invalidRequest'), localeFrom(request.headers['accept-language']));
      return reply.status(status).send({ code: 'invalid', message });
    },
  });
  await app.register(cookie, { secret: config.sessionSecret });

  const sessionOf = (request: FastifyRequest): Session | undefined => {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return undefined;
    const unsigned = request.unsignCookie(raw);
    return unsigned.valid ? sessions.get(unsigned.value) : undefined;
  };

  const startSession = (reply: FastifyReply, session: Session) => {
    reply.setCookie(SESSION_COOKIE, session.id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      signed: true,
      maxAge: 30 * 24 * 60 * 60,
    });
  };

  const endSession = (request: FastifyRequest, reply: FastifyReply) => {
    const session = sessionOf(request);
    if (session) {
      sessions.delete(session.id);
      registry.forget(session.id);
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
  };

  app.addHook('onSend', async (_request, reply) => secureHeaders(reply));

  // As rotas de entrada são as únicas abertas a quem não tem sessão: limite por IP, somado entre elas.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (_request, context) => new RateLimitedError(Math.ceil(context.ttl / 1000)),
  });
  const limited = { rateLimit: { max: deps.authAttemptsPerMinute ?? 60, timeWindow: 60_000, groupId: 'auth' } };
  // Outro site não consegue enviar este cabeçalho sem CORS, o que barra CSRF nas escritas.
  const requireFetchHeader = (request: FastifyRequest) => {
    if (request.headers['x-requested-with'] !== 'fetch') throw new ValidationError(msg('invalidRequest'));
  };

  // Mensagens no idioma escolhido na interface, que o navegador manda em Accept-Language.
  const localeOf = (request: FastifyRequest) => localeFrom(request.headers['accept-language']);
  const say = (request: FastifyRequest, key: Parameters<typeof msg>[0], params?: Parameters<typeof msg>[1]) =>
    render(msg(key, params), localeOf(request));

  app.setErrorHandler((error, request, reply) => {
    const message = error instanceof LocalizedError ? error.messageIn(localeOf(request)) : '';
    if (error instanceof NotAuthenticatedError) {
      endSession(request, reply);
      return reply.status(401).send({ code: 'unauthenticated', message });
    }
    if (error instanceof CherryPickConflictError) {
      return reply.status(409).send({
        code: 'cherry-pick-conflict',
        message,
        pullRequestId: error.pullRequestId,
        baseBranch: error.baseBranch,
      });
    }
    if (error instanceof ProviderUnavailableError) {
      return reply.status(502).send({ code: 'provider-unavailable', provider: error.provider, message });
    }
    if (error instanceof ValidationError) {
      return reply.status(400).send({ code: 'invalid', message });
    }
    if (error instanceof NotFoundError) {
      return reply.status(404).send({ code: 'not-found', message });
    }
    if (error instanceof RateLimitedError) {
      return reply
        .header('Retry-After', String(error.retryAfterSeconds))
        .status(429)
        .send({ code: 'rate-limited', message });
    }
    // Erros do próprio Fastify (JSON malformado, corpo grande demais) são do cliente, não nossos.
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({ code: 'invalid', message: say(request, 'invalidRequest') });
    }
    request.log.error(error);
    return reply.status(500).send({ code: 'internal', message: say(request, 'internalError') });
  });

  // ---- Login ----

  // Público: a tela de entrada precisa saber qual fluxo mostrar antes de existir sessão.
  app.get('/auth/mode', async () => ({
    microsoft: config.demo || !!identityProvider,
    pat: !config.demo,
    demo: config.demo,
    defaultOrganization: config.demo ? '' : config.organization,
  }));

  if (!config.demo) {
    const transport = new PatTransport();
    const validatePat = deps.validatePat ?? createPatValidator(config);

    // A chave pública e um nonce de uso único para o próximo envio de token.
    app.get('/auth/pat/key', { config: limited }, async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return { algorithm: 'RSA-OAEP-256+A256GCM', publicKey: transport.publicKeySpki, nonce: transport.issueNonce() };
    });

    // Conecta (ou troca) o token de uma plataforma. As conexões se somam na mesma sessão.
    app.post<{
      Params: { provider: string };
      Body: { organization?: unknown; site?: unknown; email?: unknown; encryptedToken?: unknown };
    }>('/auth/pat/:provider', { config: limited }, async (request, reply) => {
      requireFetchHeader(request);
      const provider = PAT_PROVIDERS.find((p) => p === request.params.provider);
      if (!provider) throw new NotFoundError(msg('unknownPlatform'));
      const label = PROVIDER_LABELS[provider];
      const { account, email } = parseAccount(provider, request.body ?? {});
      if (typeof request.body?.encryptedToken !== 'string') throw new ValidationError(msg('tokenRequired'));
      const token = transport.decrypt(request.body.encryptedToken).trim();
      // Só caracteres visíveis: o token vai num cabeçalho HTTP, onde quebra de linha e controle não cabem.
      if (token.length < 20 || token.length > 400 || !/^[\x21-\x7E]+$/.test(token)) throw new ValidationError(msg('tokenMalformed'));

      let validation: PatValidation;
      try {
        validation = await validatePat(provider, { account, token, email });
      } catch (error) {
        if (error instanceof NotAuthenticatedError) {
          return reply.status(422).send({
            code: 'invalid-token',
            message: say(request, 'tokenRejected', { provider: label }),
          });
        }
        if (error instanceof ProviderUnavailableError && (error.status === 404 || error.status === 403)) {
          return reply.status(422).send({ code: 'invalid-token', message: say(request, 'tokenNoAccess', { account }) });
        }
        throw error;
      }

      const { owner, cloudId } = validation;
      const connection = { account, sealedToken: sessions.seal(token), handle: owner.email ?? owner.name, email, cloudId };
      const current = sessionOf(request);
      let session: Session;
      if (current?.mode === 'pat') {
        // Trocar o token de uma plataforma substitui só a conexão dela; as outras continuam.
        sessions.update(current.id, (stored) => {
          stored.connections = { ...stored.connections, [provider]: connection };
          if (isSource(provider) && (!stored.activeSource || stored.activeSource === provider)) {
            stored.activeSource = provider;
            stored.user = { name: owner.name, email: owner.email };
          }
        });
        registry.forget(current.id);
        session = sessions.get(current.id)!;
      } else {
        endSession(request, reply);
        session = sessions.create({
          mode: 'pat',
          user: { name: owner.name, email: owner.email },
          connections: { [provider]: connection },
          activeSource: isSource(provider) ? provider : undefined,
        });
        startSession(reply, session);
      }
      return { provider, account, user: { name: owner.name, email: owner.email } };
    });

    // Escolhe qual plataforma conectada fornece os PRs.
    app.post<{ Body: { provider?: unknown } }>('/auth/active', async (request, reply) => {
      requireFetchHeader(request);
      const session = sessionOf(request);
      if (!session) throw new NotAuthenticatedError();
      const provider = PAT_PROVIDERS.filter(isSource).find((p) => p === request.body?.provider);
      const connection = provider && session.connections?.[provider];
      if (session.mode !== 'pat' || !provider || !connection) throw new ValidationError(msg('platformNotConnected'));
      sessions.update(session.id, (stored) => {
        stored.activeSource = provider;
        stored.user = { name: stored.user.name, email: connection.handle ?? stored.user.email };
      });
      registry.forget(session.id);
      return reply.status(204).send();
    });
  }

  app.get('/auth/microsoft/login', { config: limited }, async (request, reply) => {
    if (config.demo) {
      // Quem já está na demonstração continua na mesma sessão, em vez de acumular outra a cada visita.
      if (!sessionOf(request)) {
        startSession(reply, sessions.create({ mode: 'demo', user: { name: ALEX.name, email: ALEX.email } }));
      }
      return reply.redirect(config.appUrl);
    }
    // Sem app registration o login com Microsoft não existe; a tela de entrada oferece o token.
    if (!identityProvider) return reply.redirect(`${config.appUrl}/login?erro=indisponivel`);
    const login = identityProvider.beginLogin();
    reply.setCookie(OAUTH_COOKIE, JSON.stringify({ state: login.state, codeVerifier: login.codeVerifier }), {
      path: '/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      signed: true,
      maxAge: 600,
    });
    return reply.redirect(login.url);
  });

  app.get('/auth/microsoft/callback', { config: limited }, async (request, reply) => {
    const query = request.query as { code?: string; state?: string; error?: string };
    const raw = request.cookies[OAUTH_COOKIE];
    reply.clearCookie(OAUTH_COOKIE, { path: '/auth' });
    const pending = raw ? request.unsignCookie(raw) : undefined;
    const saved = pending?.valid ? (JSON.parse(pending.value) as { state: string; codeVerifier: string }) : undefined;

    if (query.error || !query.code || !saved || saved.state !== query.state) {
      return reply.redirect(`${config.appUrl}/login?erro=${query.error === 'access_denied' ? 'cancelado' : 'falha'}`);
    }
    try {
      const { tokens, profile } = await identityProvider!.completeLogin(query.code, saved.codeVerifier);
      // A sessão anterior deste navegador não sobrevive a uma nova entrada.
      endSession(request, reply);
      startSession(reply, sessions.create({ mode: 'microsoft', user: profile, tokens }));
      return reply.redirect(config.appUrl);
    } catch (error) {
      request.log.warn(error);
      return reply.redirect(`${config.appUrl}/login?erro=falha`);
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    requireFetchHeader(request);
    endSession(request, reply);
    return reply.status(204).send();
  });

  // ---- API ----

  app.register(async (api) => {
    api.addHook('preHandler', async (request) => {
      if (!sessionOf(request)) throw new NotAuthenticatedError();
      if (request.method !== 'GET') requireFetchHeader(request);
      const params = (request.params ?? {}) as Record<string, string>;
      for (const name of ['projectId', 'repositoryId'] as const) {
        if (name in params && !isSafeSegment(params[name]!)) throw new ValidationError(msg('invalidId'));
      }
      for (const name of ['pullRequestId', 'workItemId'] as const) {
        if (name in params && !/^[1-9]\d{0,14}$/.test(params[name]!)) throw new ValidationError(msg('invalidId'));
      }
    });

    // Parâmetro repetido na URL (?q=a&q=b) chega como lista; só texto simples interessa.
    const text = (value: unknown, maxLength: number) => (typeof value === 'string' ? value.slice(0, maxLength) : '');

    const connection = (request: FastifyRequest) => registry.for(sessionOf(request)!);
    type RepoParams = { projectId: string; repositoryId: string };

    // Fotos de perfil passam pelo servidor, porque o provedor só as entrega a quem está autenticado nele.
    const avatars = new Map<string, { at: number; avatar: { contentType: string; data: Buffer } | null }>();

    api.get<{ Params: { key: string } }>('/avatars/:key', async (request, reply) => {
      const session = sessionOf(request)!;
      if (request.params.key.length > MAX_AVATAR_KEY_LENGTH) throw new ValidationError(msg('invalidId'));
      const scope = session.activeSource ? `${session.activeSource}:${session.connections?.[session.activeSource]?.account}` : config.organization;
      const cacheKey = `${session.mode}|${scope}|${request.params.key}`;
      let cached = avatars.get(cacheKey);
      if (!cached || Date.now() - cached.at > (cached.avatar ? AVATAR_TTL_MS : MISSING_AVATAR_TTL_MS)) {
        const avatar = await connection(request).sourceControl.getAvatar(request.params.key);
        cached = { at: Date.now(), avatar: avatar && AVATAR_TYPES.has(avatar.contentType) ? avatar : null };
        // Regravar leva a chave para o fim do Map; ao passar do limite, saem as mais antigas.
        avatars.delete(cacheKey);
        avatars.set(cacheKey, cached);
        for (const oldest of avatars.keys()) {
          if (avatars.size <= MAX_CACHED_AVATARS) break;
          avatars.delete(oldest);
        }
      }
      if (!cached.avatar) return reply.status(404).send({ code: 'not-found', message: say(request, 'noPhoto') });
      return reply
        .header('Content-Type', cached.avatar.contentType)
        .header('Cache-Control', 'private, max-age=21600')
        .header('Content-Security-Policy', "default-src 'none'; sandbox")
        .send(cached.avatar.data);
    });

    api.get('/me', async (request) => {
      const session = sessionOf(request)!;
      const connections = session.connections ?? {};
      const source: SourceProvider | undefined = session.mode === 'pat' ? session.activeSource : 'azure-devops';
      // Com o Azure DevOps as tarefas vêm dele mesmo; com o GitHub, do Jira, se estiver conectado.
      const tracker: PatProvider | undefined =
        source === 'azure-devops' ? 'azure-devops' : source === 'github' && connections.jira ? 'jira' : undefined;

      // A foto é um detalhe: se o provedor falhar aqui, o usuário segue com as iniciais.
      const me =
        session.mode === 'demo' || !source
          ? undefined
          : await Promise.resolve()
              .then(() => connection(request).sourceControl.currentUser())
              .catch((error) => {
                if (error instanceof NotAuthenticatedError) throw error;
                return undefined;
              });

      return {
        user: { ...session.user, avatarKey: me?.avatarKey },
        demo: session.mode === 'demo',
        mode: session.mode,
        loginProvider: 'microsoft',
        organization: (source && connections[source]?.account) ?? config.organization,
        source: source ? { provider: source, name: PROVIDER_LABELS[source] } : null,
        tracker: tracker ? { provider: tracker, name: PROVIDER_LABELS[tracker] } : null,
        // Azure DevOps sempre primeiro; é a ordem em que as plataformas aparecem na interface.
        accounts: PAT_PROVIDERS.map((provider) => {
          if (session.mode !== 'pat') {
            const connected = provider === 'azure-devops';
            return connected
              ? { provider, connected, active: true, handle: session.user.email ?? session.user.name }
              : { provider, connected };
          }
          const saved = connections[provider];
          return saved
            ? { provider, connected: true, active: provider === source, handle: saved.handle ?? saved.account, account: saved.account }
            : { provider, connected: false };
        }),
      };
    });

    api.get('/projects', async (request) => listProjects(connection(request), config.projects));

    api.get<{ Params: { projectId: string } }>('/projects/:projectId/board', async (request) =>
      getBoard(connection(request), request.params.projectId),
    );

    api.get<{ Params: { projectId: string } }>('/projects/:projectId/lanes', async (request) =>
      getReleaseLanes(connection(request), { projectId: request.params.projectId, branching: config.branching }),
    );

    api.get<{ Params: RepoParams }>('/projects/:projectId/repositories/:repositoryId/lane', async (request) =>
      getReleaseLane(connection(request), { ...request.params, branching: config.branching }),
    );

    api.get<{ Params: RepoParams; Querystring: { branch?: string } }>(
      '/projects/:projectId/repositories/:repositoryId/release',
      async (request) =>
        getReleaseDetails(connection(request), {
          ...request.params,
          branch: text(request.query.branch, 250) || undefined,
          branching: config.branching,
        }),
    );

    api.post<{ Params: RepoParams; Body: { name?: unknown; pullRequestIds?: unknown } }>(
      '/projects/:projectId/repositories/:repositoryId/releases',
      async (request, reply) => {
        const { name, pullRequestIds } = request.body ?? {};
        if (typeof name !== 'string' || !Array.isArray(pullRequestIds) || pullRequestIds.length === 0 || !pullRequestIds.every(isPositiveInteger)) {
          throw new ValidationError(msg('branchAndPrsRequired'));
        }
        if (pullRequestIds.length > MAX_RELEASE_PULL_REQUESTS) {
          throw new ValidationError(msg('tooManyPullRequests', { max: MAX_RELEASE_PULL_REQUESTS }));
        }
        const created = await createRelease(connection(request), {
          ...request.params,
          name,
          pullRequestIds,
          branching: config.branching,
        });
        return reply.status(201).send(created);
      },
    );

    api.get<{ Params: { projectId: string }; Querystring: { q?: string } }>(
      '/projects/:projectId/work-items',
      async (request) =>
        searchWorkItems(connection(request), { projectId: request.params.projectId, term: text(request.query.q, 200) }),
    );

    type LinkParams = RepoParams & { pullRequestId: string; workItemId: string };
    const linkRoute =
      '/projects/:projectId/repositories/:repositoryId/pull-requests/:pullRequestId/work-items/:workItemId';
    const refOf = (params: LinkParams) => ({
      projectId: params.projectId,
      repositoryId: params.repositoryId,
      pullRequestId: Number(params.pullRequestId),
    });

    api.put<{ Params: LinkParams }>(linkRoute, async (request, reply) => {
      await linkWorkItem(connection(request), Number(request.params.workItemId), refOf(request.params));
      return reply.status(204).send();
    });

    api.delete<{ Params: LinkParams }>(linkRoute, async (request, reply) => {
      await unlinkWorkItem(connection(request), Number(request.params.workItemId), refOf(request.params));
      return reply.status(204).send();
    });
  }, { prefix: '/api' });

  // ---- Front buildado (produção) ----

  const webDist = deps.webDist ?? resolve(import.meta.dirname, '../../../../web/dist');
  const hasWeb = existsSync(webDist);
  if (hasWeb) await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((request, reply) => {
    // Qualquer outro caminho é uma tela do front, que resolve a rota no navegador.
    const isApi = request.url.startsWith('/api/') || request.url.startsWith('/auth/');
    if (hasWeb && !isApi && request.method === 'GET') return reply.sendFile('index.html');
    return reply.status(404).send({ code: 'not-found', message: say(request, 'routeNotFound') });
  });

  return app;
}
