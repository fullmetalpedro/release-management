export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  // Epoch em ms.
  expiresAt: number;
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
}

export interface IdentityProfile {
  name: string;
  email?: string;
}

export interface IdentityProvider {
  beginLogin(): AuthorizationRequest;
  completeLogin(code: string, codeVerifier: string): Promise<{ tokens: TokenSet; profile: IdentityProfile }>;
  refresh(refreshToken: string): Promise<TokenSet>;
}
