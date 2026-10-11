export class NotAuthenticatedError extends Error {
  constructor(message = 'Sessão expirada') {
    super(message);
    this.name = 'NotAuthenticatedError';
  }
}

// O provedor não respondeu ou respondeu com erro: o board mostra o banner de sincronização.
export class ProviderUnavailableError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

export class CherryPickConflictError extends Error {
  constructor(
    public readonly pullRequestId: number,
    public readonly baseBranch: string,
  ) {
    super(`Conflito ao aplicar #${pullRequestId} sobre ${baseBranch}`);
    this.name = 'CherryPickConflictError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
