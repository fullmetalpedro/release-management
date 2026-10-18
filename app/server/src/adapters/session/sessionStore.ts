import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TokenSet } from '../../core/ports/identityProvider.ts';

export type PatProvider = 'azure-devops' | 'github' | 'jira';
export type SourceProvider = Exclude<PatProvider, 'jira'>;

export interface PatConnection {
  provider: PatProvider;
  // Organização (Azure DevOps), dono (GitHub) ou site (Jira).
  account: string;
  // O token fica selado também em memória e só é aberto na hora de chamar o provedor.
  sealedToken: string;
  // Quem é o dono do token naquela plataforma, para mostrar no menu de contas.
  handle?: string;
  // Só Jira: o e-mail entra na autenticação e o cloudId no endereço da API.
  email?: string;
  cloudId?: string;
  // Nome do dono do token, para o menu de contas trocar o nome junto com a organização ativa.
  name?: string;
  // O provedor recusou o token: a conexão continua listada, pedindo para reconectar, e as outras seguem valendo.
  expiredAt?: number;
}

// Uma conexão por organização: `azure-devops:contoso`, `github:acme-labs`. Organização e dono não diferenciam
// maiúsculas nas duas plataformas, então o id usa a forma minúscula.
export const connectionId = (provider: PatProvider, account: string) => `${provider}:${account.toLowerCase()}`;

// O id pode vir do navegador: só valem as chaves da própria sessão ("__proto__" não é uma conexão).
export const connectionOf = (session: Session | undefined, id: unknown): PatConnection | undefined =>
  typeof id === 'string' && session?.connections && Object.hasOwn(session.connections, id) ? session.connections[id] : undefined;

export interface Session {
  id: string;
  mode: 'microsoft' | 'demo' | 'pat';
  user: { name: string; email?: string };
  tokens?: TokenSet;
  // Modo token: as conexões por id (ver connectionId) e qual delas fornece os PRs no momento.
  connections?: Record<string, PatConnection>;
  activeConnection?: string;
  createdAt: number;
  // Último uso registrado. A validade conta a partir dele (expiração deslizante); sessões antigas não o têm.
  lastSeenAt?: number;
}

type StoredSession = Session & {
  // Formatos anteriores: só o token do Azure DevOps, e depois uma conexão por plataforma.
  pat?: { organization: string; sealedToken: string };
  activeSource?: SourceProvider;
};

const isPlatform = (key: string): key is PatProvider => key === 'azure-devops' || key === 'github' || key === 'jira';

// Sessões gravadas por versões anteriores continuam valendo, já no formato de várias organizações.
function migrate(stored: StoredSession): Session {
  const { pat, activeSource, ...session } = stored;
  if (pat && !session.connections) {
    session.connections = { 'azure-devops': { provider: 'azure-devops', account: pat.organization, sealedToken: pat.sealedToken } };
  }
  if (session.connections && Object.keys(session.connections).some(isPlatform)) {
    const byId: Record<string, PatConnection> = {};
    for (const [key, connection] of Object.entries(session.connections)) {
      const provider = isPlatform(key) ? key : connection.provider;
      byId[connectionId(provider, connection.account)] = { ...connection, provider };
    }
    session.connections = byId;
    const active = pat ? 'azure-devops' : activeSource;
    const found = active && Object.entries(byId).find(([, connection]) => connection.provider === active);
    if (found) session.activeConnection = found[0];
  }
  return session;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SESSION_MAX_AGE_DAYS = 30;
// O uso renova a validade, mas grava no máximo uma vez por hora por sessão, e não a cada requisição.
const RENEW_INTERVAL_MS = 60 * 60 * 1000;
// Teto de sessões vivas: acima dele saem as mais antigas, para a memória (e o arquivo) não crescerem sem limite.
const MAX_SESSIONS = 10_000;

const lastSeen = (session: Session) => session.lastSeenAt ?? session.createdAt;

// Sessões ficam em memória e num arquivo cifrado, para os refresh tokens sobreviverem a um restart sem ficarem legíveis em disco.
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly key: Buffer;
  // Validade de uma sessão sem uso; o cookie usa o mesmo valor.
  readonly maxAgeMs: number;

  constructor(
    secret: string,
    private readonly filePath?: string,
    options: { maxAgeDays?: number } = {},
  ) {
    this.key = scryptSync(secret, 'release-management.sessions', 32);
    this.maxAgeMs = (options.maxAgeDays ?? DEFAULT_SESSION_MAX_AGE_DAYS) * DAY_MS;
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
    const now = Date.now();
    const session: Session = { ...data, id: randomBytes(32).toString('base64url'), createdAt: now, lastSeenAt: now };
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
    if (session && this.isExpired(session)) {
      this.delete(id);
      return undefined;
    }
    return session;
  }

  // Registra o uso: a validade recomeça a contar. Devolve true quando renovou (e gravou), para o cookie ser
  // renovado junto; dentro do intervalo de renovação nada muda.
  touch(id: string): boolean {
    const session = this.get(id);
    if (!session) return false;
    const now = Date.now();
    if (now - lastSeen(session) < RENEW_INTERVAL_MS) return false;
    session.lastSeenAt = now;
    this.persist();
    return true;
  }

  private isExpired(session: Session, now = Date.now()) {
    return now - lastSeen(session) > this.maxAgeMs;
  }

  // Sessões vencidas que ninguém voltou a usar não ficam guardadas para sempre.
  private dropExpired() {
    const now = Date.now();
    for (const [id, session] of this.sessions) if (this.isExpired(session, now)) this.sessions.delete(id);
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
      for (const stored of JSON.parse(json) as StoredSession[]) this.sessions.set(stored.id, migrate(stored));
      this.dropExpired();
    } catch (error) {
      // Sem arquivo é o primeiro boot. Ilegível (outro SESSION_SECRET, arquivo corrompido): começa sem sessões e
      // todos entram de novo, o que precisa aparecer no log.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      console.warn(
        `Não foi possível ler as sessões gravadas em ${this.filePath} (${(error as Error).message}). ` +
          'O SESSION_SECRET mudou ou o arquivo está corrompido: todos precisarão entrar de novo.',
      );
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
