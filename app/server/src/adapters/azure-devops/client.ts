import { NotAuthenticatedError, ProviderUnavailableError } from '../../core/domain/errors.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  contentType?: string;
  apiVersion?: string;
  // POST que só consulta (WIQL, lote de work items) pode ser repetido como um GET.
  readOnly?: boolean;
}

export class AzureDevOpsHttpError extends ProviderUnavailableError {
  constructor(status: number, message: string) {
    super('azure-devops', message, status);
    this.name = 'AzureDevOpsHttpError';
  }
}

export const bearer = (token: string) => `Bearer ${token}`;
export const basicFromPat = (pat: string) => `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

export class AzureDevOpsClient {
  constructor(
    public readonly organization: string,
    private readonly getAuthorization: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 20_000,
    private readonly readRetries = 4,
    private readonly retryDelayMs = 300,
  ) {}

  get baseUrl() {
    return `https://dev.azure.com/${encodeURIComponent(this.organization)}`;
  }

  get<T>(path: string, options?: RequestOptions) {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options?: RequestOptions) {
    return this.request<T>('POST', path, options);
  }

  patch<T>(path: string, options?: RequestOptions) {
    return this.request<T>('PATCH', path, options);
  }

  // Imagem binária (foto de perfil). Devolve undefined quando o provedor não tem o recurso.
  async getImage(path: string): Promise<{ contentType: string; data: Buffer } | undefined> {
    const authorization = await this.getAuthorization();
    let response: Response | undefined;
    for (let attempt = 1; !response; attempt++) {
      try {
        response = await this.fetchImpl(this.baseUrl + path, {
          headers: { Authorization: authorization, Accept: 'image/*' },
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt > this.readRetries) {
          throw new ProviderUnavailableError('azure-devops', `Azure DevOps não respondeu: ${(error as Error).message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      throw new NotAuthenticatedError('O Azure DevOps recusou o token da sessão');
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!response.ok || !contentType.startsWith('image/')) return undefined;
    return { contentType, data: Buffer.from(await response.arrayBuffer()) };
  }

  private async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    url.searchParams.set('api-version', options.apiVersion ?? '7.1');

    const authorization = await this.getAuthorization();
    const send = () =>
      this.fetchImpl(url.toString(), {
        method,
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          ...(options.body !== undefined ? { 'Content-Type': options.contentType ?? 'application/json' } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        // O redirect para a página de login é a resposta do provedor a um token recusado; segui-lo esconderia isso.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });

    let response: Response | undefined;
    // Leituras são repetidas em queda de conexão; escritas não, para não aplicar duas vezes.
    const attempts = method === 'GET' || options.readOnly ? 1 + this.readRetries : 1;
    for (let attempt = 1; !response; attempt++) {
      try {
        response = await send();
      } catch (error) {
        if (attempt >= attempts) {
          throw new ProviderUnavailableError('azure-devops', `Azure DevOps não respondeu: ${(error as Error).message}`);
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }

    const isJson = (response.headers.get('content-type') ?? '').includes('json');
    const redirected = response.status >= 300 && response.status < 400;
    // Token recusado: 401, redirect para o login ou a própria página de login em HTML.
    if (response.status === 401 || redirected || (response.ok && response.status !== 204 && !isJson)) {
      throw new NotAuthenticatedError('O Azure DevOps recusou o token da sessão');
    }
    if (!response.ok) {
      const detail = isJson ? ((await response.json().catch(() => ({}))) as { message?: string }).message : undefined;
      throw new AzureDevOpsHttpError(response.status, detail ?? `Azure DevOps respondeu ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}

export { mapLimit } from '../../core/concurrency.ts';
