import { ApiError, type ProviderId } from './api';
import { localeTag, t } from './i18n';

// Formas de entrar que o servidor oferece.
export interface AuthMode {
  microsoft: boolean;
  pat: boolean;
  demo: boolean;
  defaultOrganization: string;
}

export async function fetchAuthMode(): Promise<AuthMode> {
  const response = await fetch('/auth/mode', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new ApiError(response.status, 'error', t('errors.serverUnavailable'));
  return (await response.json()) as AuthMode;
}

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const toBase64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

// O token é cifrado aqui e só o envelope sai do navegador: uma chave AES descartável cifra `{ nonce, token }` e a
// chave pública do servidor embrulha essa chave. O nonce vem com a chave pública e vale para um único envio.
async function encryptForServer(token: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/auth/pat/key', { headers: { Accept: 'application/json' }, cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'network', t('errors.offline'));
  }
  if (!response.ok) throw new ApiError(response.status, 'error', t('errors.tokenPrep'));
  const { publicKey, nonce } = (await response.json()) as { publicKey: string; nonce: string };
  const wrappingKey = await crypto.subtle.importKey('spki', fromBase64(publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, [
    'encrypt',
  ]);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const [wrappedKey, sealed] = await Promise.all([
    crypto.subtle.encrypt({ name: 'RSA-OAEP' }, wrappingKey, rawKey),
    crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(JSON.stringify({ nonce, token }))),
  ]);
  const envelope = new Uint8Array(wrappedKey.byteLength + iv.byteLength + sealed.byteLength);
  envelope.set(new Uint8Array(wrappedKey), 0);
  envelope.set(iv, wrappedKey.byteLength);
  envelope.set(new Uint8Array(sealed), wrappedKey.byteLength + iv.byteLength);
  return toBase64(envelope.buffer);
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
      headers: {
        Accept: 'application/json',
        'Accept-Language': localeTag(),
        'Content-Type': 'application/json',
        'X-Requested-With': 'fetch',
      },
      body: JSON.stringify({ ...account, encryptedToken }),
    });
  } catch {
    throw new ApiError(0, 'network', t('errors.offline'));
  }
  const payload = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
  if (!response.ok) {
    throw new ApiError(response.status, payload.code ?? 'error', payload.message ?? t('errors.http', { status: response.status }));
  }
  return payload as { id: string; provider: ProviderId; account: string; user: { name: string; email?: string } };
}
