import { constants, generateKeyPairSync, privateDecrypt, type KeyObject } from 'node:crypto';
import { ValidationError } from '../../core/domain/errors.ts';

// O navegador cifra o token com esta chave pública antes de enviar, então ele não trafega em claro
// nem quando a aplicação roda em HTTP local. O par vive só na memória do processo.
export class PatTransport {
  private readonly privateKey: KeyObject;
  readonly publicKeySpki: string;

  constructor() {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = pair.privateKey;
    this.publicKeySpki = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  }

  decrypt(encryptedBase64: string): string {
    try {
      return privateDecrypt(
        { key: this.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        Buffer.from(encryptedBase64, 'base64'),
      ).toString('utf8');
    } catch {
      // Chave trocada por um restart do servidor entre abrir a tela e enviar.
      throw new ValidationError('Não foi possível ler o token. Recarregue a página e tente de novo.');
    }
  }
}

const ORGANIZATION = /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function parseGitHubOwner(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '') : '';
  if (!GITHUB_OWNER.test(name)) throw new ValidationError('Informe a organização ou o usuário, como em github.com/<organização>.');
  return name;
}

// O nome vira parte da URL do provedor, então só entra o que o Azure DevOps aceita como organização.
export function parseOrganization(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/^https?:\/\/dev\.azure\.com\//i, '').replace(/\/.*$/, '') : '';
  if (!ORGANIZATION.test(name)) throw new ValidationError('Informe o nome da organização, como em dev.azure.com/<organização>.');
  return name;
}
