import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenSet } from '../../core/ports/identityProvider.ts';

export type PatProvider = 'azure-devops' | 'github' | 'jira';
export type SourceProvider = Exclude<PatProvider, 'jira'>;

export interface PatConnection {
  // Organização (Azure DevOps), dono (GitHub) ou site (Jira).
  account: string;
  // O token fica selado também em memória e só é aberto na hora de chamar o provedor.
  sealedToken: string;
  // Quem é o dono do token naquela plataforma, para mostrar no menu de contas.
  handle?: string;
  // Só Jira: o e-mail entra na autenticação e o cloudId no endereço da API.
  email?: string;
  cloudId?: string;
}

export interface Session {
  id: string;
  mode: 'microsoft' | 'demo' | 'pat';
  user: { name: string; email?: string };
  tokens?: TokenSet;
  // Modo token: uma conexão por plataforma e qual delas fornece os PRs no momento.
  connections?: Partial<Record<PatProvider, PatConnection>>;
  activeSource?: SourceProvider;
  createdAt: number;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Teto de sessões vivas: acima dele saem as mais antigas, para a memória (e o arquivo) não crescerem sem limite.
const MAX_SESSIONS = 10_000;

// Sessões ficam em memória e num arquivo cifrado, para os refresh tokens sobreviverem a um restart sem ficarem legíveis em disco.
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly filePath?: string,
  ) {
    this.key = scryptSync(secret, 'release-management.sessions', 32);
    this.load();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  open(sealed: string): string {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  create(data: Omit<Session, 'id' | 'createdAt'>): Session {
    const session: Session = { ...data, id: randomBytes(32).toString('base64url'), createdAt: Date.now() };
    this.sessions.set(session.id, session);
    this.dropExpired();
    for (const oldest of this.sessions.keys()) {
      if (this.sessions.size <= MAX_SESSIONS) break;
      this.sessions.delete(oldest);
    }
    this.persist();
    return session;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (session && Date.now() - session.createdAt > MAX_AGE_MS) {
      this.delete(id);
      return undefined;
    }
    return session;
  }

  // Sessões vencidas que ninguém voltou a usar não ficam guardadas para sempre.
  private dropExpired() {
    const limit = Date.now() - MAX_AGE_MS;
    for (const [id, session] of this.sessions) if (session.createdAt < limit) this.sessions.delete(id);
  }

  // Altera a sessão no lugar e grava.
  update(id: string, change: (session: Session) => void) {
    const session = this.sessions.get(id);
    if (!session) return;
    change(session);
    this.persist();
  }

  updateTokens(id: string, tokens: TokenSet) {
    const session = this.sessions.get(id);
    if (!session) return;
    session.tokens = tokens;
    this.persist();
  }

  delete(id: string) {
    if (this.sessions.delete(id)) this.persist();
  }

  private load() {
    if (!this.filePath) return;
    try {
      const raw = readFileSync(this.filePath);
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      for (const stored of JSON.parse(json) as (Session & { pat?: { organization: string; sealedToken: string } })[]) {
        // Sessões gravadas antes de existirem várias conexões tinham só o token do Azure DevOps.
        const { pat, ...session } = stored;
        if (pat && !session.connections) {
          session.connections = { 'azure-devops': { account: pat.organization, sealedToken: pat.sealedToken } };
          session.activeSource = 'azure-devops';
        }
        this.sessions.set(session.id, session);
      }
      this.dropExpired();
    } catch {
      // Arquivo ausente ou cifrado com outro segredo: começa sem sessões e os usuários entram de novo.
    }
  }

  private persist() {
    if (!this.filePath) return;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify([...this.sessions.values()]), 'utf8'), cipher.final()]);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.tmp`;
    writeFileSync(temp, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
    renameSync(temp, this.filePath);
  }
}
