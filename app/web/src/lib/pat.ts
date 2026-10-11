import { ApiError, type ProviderId } from './api';

// Formas de entrar que o servidor oferece.
export interface AuthMode {
  microsoft: boolean;
  pat: boolean;
  demo: boolean;
  defaultOrganization: string;
}

export async function fetchAuthMode(): Promise<AuthMode> {
  const response = await fetch('/auth/mode', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ApiError(response.status, 'error', 'Servidor indisponível');
  return (await response.json()) as AuthMode;
}

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toBase64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

// O token é cifrado aqui, com a chave pública do servidor, e só o texto cifrado sai do navegador.
async function encryptForServer(token: string): Promise<string> {
  const response = await fetch('/auth/pat/key', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ApiError(response.status, 'error', 'Não foi possível preparar o envio do token');
  const { publicKey } = (await response.json()) as { publicKey: string };
  const key = await crypto.subtle.importKey('spki', fromBase64(publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, [
    'encrypt',
  ]);
  return toBase64(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(token)));
}

// Azure DevOps e GitHub pedem a organização; o Jira, o site e o e-mail da conta.
export type PlatformAccount = { organization: string } | { site: string; email: string };

export async function connectPlatform(provider: ProviderId, account: PlatformAccount, token: string) {
  const encryptedToken = await encryptForServer(token);
  let response: Response;
  try {
    response = await fetch(`/auth/pat/${provider}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      body: JSON.stringify({ ...account, encryptedToken }),
    });
  } catch {
    throw new ApiError(0, 'network', 'Sem conexão com o servidor');
  }
  const payload = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
  if (!response.ok) {
    throw new ApiError(response.status, payload.code ?? 'error', payload.message ?? `Erro ${response.status}`);
  }
  return payload as { provider: ProviderId; account: string; user: { name: string; email?: string } };
}
