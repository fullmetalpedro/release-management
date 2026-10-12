import { createHash, randomBytes } from 'node:crypto';
import { NotAuthenticatedError, ProviderUnavailableError } from '../../core/domain/errors.ts';
import type {
  AuthorizationRequest,
  IdentityProfile,
  IdentityProvider,
  TokenSet,
} from '../../core/ports/identityProvider.ts';
import type { FetchLike } from '../azure-devops/client.ts';
import { msg } from '../../i18n.ts';

// Resource id fixo do Azure DevOps no Entra ID.
export const AZURE_DEVOPS_SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/user_impersonation';

export interface EntraConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

const base64url = (buffer: Buffer) => buffer.toString('base64url');

export function decodeIdToken(idToken: string): IdentityProfile {
  // O token veio direto do endpoint de token por TLS, então as claims são lidas sem revalidar a assinatura.
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
    name?: string;
    preferred_username?: string;
    email?: string;
  };
  const email = payload.email ?? payload.preferred_username;
  return { name: payload.name ?? email ?? 'Usuário', email };
}

export class EntraIdentityProvider implements IdentityProvider {
  private readonly scopes = [AZURE_DEVOPS_SCOPE, 'openid', 'profile', 'email', 'offline_access'].join(' ');

  constructor(
    private readonly config: EntraConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private get authority() {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0`;
  }

  beginLogin(): AuthorizationRequest {
    const state = base64url(randomBytes(16));
    const codeVerifier = base64url(randomBytes(32));
    const url = new URL(`${this.authority}/authorize`);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: this.config.redirectUri,
      response_mode: 'query',
      scope: this.scopes,
      state,
      code_challenge: base64url(createHash('sha256').update(codeVerifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString();
    return { url: url.toString(), state, codeVerifier };
  }

  async completeLogin(code: string, codeVerifier: string) {
    const response = await this.token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.redirectUri,
      code_verifier: codeVerifier,
    });
    if (!response.id_token) throw new NotAuthenticatedError(msg('loginNoIdentity'));
    return { tokens: this.toTokenSet(response), profile: decodeIdToken(response.id_token) };
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    const response = await this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return this.toTokenSet(response, refreshToken);
  }

  private toTokenSet(response: TokenResponse, previousRefreshToken?: string): TokenSet {
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token ?? previousRefreshToken,
      expiresAt: this.now() + response.expires_in * 1000,
    };
  }

  private async token(params: Record<string, string>): Promise<TokenResponse> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.authority}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          scope: this.scopes,
          ...params,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new ProviderUnavailableError('microsoft', msg('microsoftUnavailable', { detail: (error as Error).message }));
    }
    const body = (await response.json().catch(() => ({}))) as TokenResponse;
    if (!response.ok || body.error) {
      // A descrição que a Microsoft devolve traz ids do tenant, do aplicativo e de rastreio: fica no log do
      // servidor, e quem usa recebe a mensagem do catálogo.
      console.warn(`Microsoft recusou a troca de token (${response.status} ${body.error ?? ''}): ${body.error_description ?? ''}`);
      // invalid_grant cobre código expirado, refresh token revogado e consentimento retirado.
      if (response.status === 400 || response.status === 401) throw new NotAuthenticatedError(msg('microsoftRejected'));
      throw new ProviderUnavailableError('microsoft', msg('microsoftStatus', { status: response.status }));
    }
    return body;
  }
}
