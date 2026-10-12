import { NotAuthenticatedError, ProviderUnavailableError } from '../core/domain/errors.ts';
import { msg, type Localized } from '../i18n.ts';
import { isTransientStatus, retryDelay } from './azure-devops/client.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ProviderHttpError extends ProviderUnavailableError {
  constructor(provider: string, status: number, message: string | Localized) {
    super(provider, message, status);
    this.name = 'ProviderHttpError';
  }
}

export interface JsonRequest {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  // POST que só consulta pode ser repetido como um GET.
  readOnly?: boolean;
}

export interface JsonClientOptions {
  provider: string;
  // Nome do provedor nas mensagens ao usuário.
  label: string;
  baseUrl: string;
  headers: () => Promise<Record<string, string>>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  readRetries?: number;
  retryDelayMs?: number;
}

// Cliente HTTP comum aos provedores REST (GitHub, Jira): autenticação por cabeçalho, repetição só em
// leituras e a mesma tradução de falhas para os erros do núcleo.
export class JsonClient {
  constructor(private readonly options: JsonClientOptions) {}

  get baseUrl() {
    return this.options.baseUrl;
  }

  async send(path: string, request: JsonRequest = {}): Promise<Response> {
    const { provider, label, fetchImpl = fetch, timeoutMs = 20_000, readRetries = 4, retryDelayMs = 300 } = this.options;
    const method = request.method ?? 'GET';
    const url = new URL(this.options.baseUrl + path);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = {
      Accept: 'application/json',
      ...(await this.options.headers()),
      ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...request.headers,
    };

    const attempts = method === 'GET' || request.readOnly ? 1 + readRetries : 1;
    let response: Response | undefined;
    for (let attempt = 1; !response; attempt++) {
      let received: Response | undefined;
      try {
        received = await fetchImpl(url.toString(), {
          method,
          headers,
          body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
          // O token não acompanha redirecionamentos.
          redirect: 'manual',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (attempt >= attempts) {
          throw new ProviderUnavailableError(provider, msg('providerDownDetail', { provider: label, detail: (error as Error).message }));
        }
      }
      if (received && (attempt >= attempts || !isTransientStatus(received.status))) response = received;
      else await new Promise((resolve) => setTimeout(resolve, retryDelay(received, attempt, retryDelayMs)));
    }
    // Um 3xx aqui não é token recusado: o GitHub responde 301 para branch ou repositório renomeado. Ele segue
    // como erro HTTP comum, para quem chamou decidir.
    if (response.status === 401) throw new NotAuthenticatedError(msg('sessionTokenRejected', { provider: label }));
    return response;
  }

  async json<T>(path: string, request: JsonRequest = {}): Promise<T> {
    const response = await this.send(path, request);
    if (!response.ok) {
      const detail = (await response.json().catch(() => ({}))) as { message?: string; errorMessages?: string[] };
      const message =
        detail.message ?? detail.errorMessages?.join(' ') ?? msg('providerStatus', { provider: this.options.label, status: response.status });
      throw new ProviderHttpError(this.options.provider, response.status, message);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  get<T>(path: string, query?: JsonRequest['query']) {
    return this.json<T>(path, { query });
  }
}

export const isHttpStatus = (error: unknown, ...statuses: number[]) =>
  error instanceof ProviderHttpError && statuses.includes(error.status ?? 0);
