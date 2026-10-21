import { msg, render, type Locale, type Localized } from '../../i18n.ts';

// A mensagem pode vir do provedor (texto livre) ou do catálogo, e então sai no idioma de quem pediu.
export class LocalizedError extends Error {
  readonly localized?: Localized;
  constructor(message: string | Localized) {
    super(typeof message === 'string' ? message : render(message));
    if (typeof message !== 'string') this.localized = message;
  }

  messageIn(locale: Locale): string {
    return this.localized ? render(this.localized, locale) : this.message;
  }
}

export class NotAuthenticatedError extends LocalizedError {
  constructor(message: string | Localized = msg('sessionExpired')) {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

// Modo token: o provedor recusou o token de uma organização. Só aquela conexão cai; a sessão continua.
export class ConnectionExpiredError extends LocalizedError {
  constructor(
    public readonly connectionId: string,
    public readonly account: string,
  ) {
    super(msg('connectionExpired', { account }));
    this.name = 'ConnectionExpiredError';
  }
}

// O token lê, mas não tem permissão para esta escrita (token só de leitura). A conexão continua valendo; só a ação
// fica desabilitada.
export class WriteNotAllowedError extends LocalizedError {
  constructor(
    public readonly connectionId: string,
    public readonly account: string,
    public readonly capability: 'createRelease' | 'linkWorkItems',
  ) {
    super(msg(capability === 'createRelease' ? 'readOnlyRelease' : 'readOnlyLink', { account }));
    this.name = 'WriteNotAllowedError';
  }
}

// O provedor não respondeu ou respondeu com erro: o board mostra o banner de sincronização.
export class ProviderUnavailableError extends LocalizedError {
  constructor(
    public readonly provider: string,
    message: string | Localized,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export class CherryPickConflictError extends LocalizedError {
  constructor(
    public readonly pullRequestId: number,
    public readonly baseBranch: string,
  ) {
    super(msg('cherryPickConflict', { id: pullRequestId, base: baseBranch }));
    this.name = 'CherryPickConflictError';
  }
}

export class ValidationError extends LocalizedError {
  constructor(message: string | Localized) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends LocalizedError {
  constructor(message: string | Localized) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class RateLimitedError extends LocalizedError {
  constructor(public readonly retryAfterSeconds: number) {
    super(msg('tooManyRequests'));
    this.name = 'RateLimitedError';
  }
}
