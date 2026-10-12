import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt, randomBytes, type KeyObject } from 'node:crypto';
import { ValidationError } from '../../core/domain/errors.ts';
import { msg } from '../../i18n.ts';

const NONCE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_NONCES = 5_000;
const WRAPPED_KEY_BYTES = 256;
const IV_BYTES = 12;
const TAG_BYTES = 16;

// O navegador cifra o token antes de enviar, para ele não aparecer em claro em logs de proxy, ferramentas de rede
// ou no corpo da requisição. Isso é uma camada a mais, não um substituto do HTTPS: sem TLS, quem altera o tráfego
// pode trocar a chave pública. O par de chaves vive só na memória do processo.
//
// Envelope (base64): chave AES-256 embrulhada com RSA-OAEP | IV | texto cifrado com AES-GCM e sua tag. O texto é
// `{ nonce, token }`: o nonce sai junto com a chave pública e vale uma única vez, então um envelope capturado
// não pode ser reenviado.
export class PatTransport {
  private readonly privateKey: KeyObject;
  readonly publicKeySpki: string;
  private readonly nonces = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKeySpki = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  issueNonce(): string {
    const now = this.now();
    for (const [nonce, expiresAt] of this.nonces) {
      if (expiresAt > now && this.nonces.size < MAX_PENDING_NONCES) break;
      // O Map guarda na ordem de emissão: os primeiros são os mais antigos.
      this.nonces.delete(nonce);
    }
    const nonce = randomBytes(16).toString('base64url');
    this.nonces.set(nonce, now + NONCE_TTL_MS);
    return nonce;
  }

  decrypt(envelopeBase64: string): string {
    let payload: { nonce?: unknown; token?: unknown };
    try {
      const envelope = Buffer.from(envelopeBase64, 'base64');
      const key = privateDecrypt(
        { key: this.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        envelope.subarray(0, WRAPPED_KEY_BYTES),
      );
      const iv = envelope.subarray(WRAPPED_KEY_BYTES, WRAPPED_KEY_BYTES + IV_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(envelope.subarray(envelope.length - TAG_BYTES));
      const sealed = envelope.subarray(WRAPPED_KEY_BYTES + IV_BYTES, envelope.length - TAG_BYTES);
      payload = JSON.parse(Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8'));
    } catch {
      // Chave trocada por um restart do servidor entre abrir a tela e enviar, ou envelope adulterado.
      throw new ValidationError(msg('tokenUnreadable'));
    }
    const { nonce, token } = payload;
    if (typeof nonce !== 'string' || typeof token !== 'string') throw new ValidationError(msg('tokenUnreadable'));
    const expiresAt = this.nonces.get(nonce);
    this.nonces.delete(nonce);
    if (!expiresAt || expiresAt <= this.now()) throw new ValidationError(msg('tokenUnreadable'));
    return token;
  }
}

const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function parseGitHubOwner(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '') : '';
  if (!GITHUB_OWNER.test(name)) throw new ValidationError(msg('githubOwnerInvalid'));
  return name;
}

// O nome vira parte da URL do provedor, então só entra o que o Azure DevOps aceita como organização.
export function parseOrganization(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/^https?:\/\/dev\.azure\.com\//i, '').replace(/\/.*$/, '') : '';
  if (!ORGANIZATION.test(name)) throw new ValidationError(msg('organizationInvalid'));
  return name;
}
