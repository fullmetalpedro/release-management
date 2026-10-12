import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { BranchingConfig } from './core/usecases/releaseLane.ts';
import { DEFAULT_RELEASE_PATTERN, isValidBranchName } from './core/usecases/releaseNaming.ts';
import type { EntraConfig } from './adapters/entra/identityProvider.ts';
import type { MemoryFaults } from './adapters/memory/memoryAdapters.ts';

export interface AppConfig {
  port: number;
  host: string;
  // Atrás de um proxy reverso, o IP de quem chama vem em X-Forwarded-For.
  trustProxy: boolean;
  appUrl: string;
  // Dados em memória, para demonstração e testes.
  demo: boolean;
  entra?: EntraConfig;
  organization: string;
  projects: string[];
  branching: BranchingConfig;
  sessionSecret: string;
  sessionFile?: string;
  demoFaults: MemoryFaults;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

function parseDemoFaults(value: string | undefined): MemoryFaults {
  const faults: MemoryFaults = { latencyMs: 600 };
  for (const part of (value ?? '').split(',').map((p) => p.trim())) {
    if (part === 'sync') faults.failSync = true;
    if (part.startsWith('conflict:')) {
      faults.conflictingPullRequestIds = part.slice('conflict:'.length).split('+').map(Number);
    }
  }
  return faults;
}

function releasePattern(value: string | undefined): string {
  const pattern = value?.trim() || DEFAULT_RELEASE_PATTERN;
  try {
    new RegExp(pattern);
  } catch {
    throw new Error(`RELEASE_PATTERN não é uma expressão regular válida: ${pattern}`);
  }
  return pattern;
}

function firstRelease(value: string | undefined): string {
  const name = value?.trim() || 'release/1.0';
  if (!isValidBranchName(name)) throw new Error(`RELEASE_FIRST não é um nome de branch válido: ${name}`);
  return name;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appUrl = (env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  // Modo de demonstração só quando pedido: dados em memória, sem provedor nenhum.
  const demo = env.AUTH_MODE === 'demo';
  const dataDir = resolve(env.DATA_DIR ?? '.data');

  const base = {
    port: Number(env.API_PORT ?? 3001),
    host: env.API_HOST ?? '127.0.0.1',
    trustProxy: env.TRUST_PROXY === 'true',
    appUrl,
    projects: (env.AZDO_PROJECTS ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    branching: {
      developBranch: env.DEVELOP_BRANCH ?? 'develop',
      baseBranches: (env.RELEASE_BASE_BRANCH ?? 'main,master')
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean),
      releasePattern: releasePattern(env.RELEASE_PATTERN),
      firstRelease: firstRelease(env.RELEASE_FIRST),
    },
    demoFaults: parseDemoFaults(env.DEMO_FAIL),
  };

  if (demo) {
    return {
      ...base,
      demo,
      projects: base.projects.length > 0 ? base.projects : ['GetNota', 'Lead Comex', 'Jane'],
      organization: 'demo',
      // As sessões de demonstração valem só enquanto o processo vive.
      sessionSecret: env.SESSION_SECRET?.trim() || randomBytes(32).toString('hex'),
    };
  }

  // A conexão por token pessoal está sempre disponível; o login com Microsoft entra quando há app registration.
  const secret = env.SESSION_SECRET?.trim();
  if (secret && secret.length < 32) throw new Error('SESSION_SECRET precisa ter pelo menos 32 caracteres');
  const microsoft = !!env.ENTRA_CLIENT_ID?.trim();
  if (microsoft) required(env, 'SESSION_SECRET');
  return {
    ...base,
    demo,
    // Com login Microsoft a organização é fixa; na conexão por token ela só preenche o campo da tela.
    organization: microsoft ? required(env, 'AZDO_ORG') : (env.AZDO_ORG?.trim() ?? ''),
    // Sem segredo configurado as sessões não vão para o disco e caem a cada restart.
    sessionSecret: secret || randomBytes(32).toString('hex'),
    sessionFile: secret ? resolve(dataDir, 'sessions.enc') : undefined,
    entra: microsoft
      ? {
          tenantId: required(env, 'ENTRA_TENANT_ID'),
          clientId: required(env, 'ENTRA_CLIENT_ID'),
          clientSecret: required(env, 'ENTRA_CLIENT_SECRET'),
          redirectUri: env.ENTRA_REDIRECT_URI ?? `${appUrl}/auth/microsoft/callback`,
        }
      : undefined,
  };
}
