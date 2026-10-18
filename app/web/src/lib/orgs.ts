import type { ProviderId } from './api';

// Organizações já usadas neste navegador, para virarem atalhos no formulário de token. Só os nomes: token e
// e-mail nunca são guardados aqui.
const KEY = 'rm.orgs';
const MAX_PER_PROVIDER = 8;

type Remembered = Partial<Record<ProviderId, string[]>>;

function read(): Remembered {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
    const result: Remembered = {};
    for (const provider of ['azure-devops', 'github', 'jira'] as const) {
      const names = (stored as Record<string, unknown>)[provider];
      if (Array.isArray(names)) result[provider] = names.filter((name): name is string => typeof name === 'string');
    }
    return result;
  } catch {
    return {};
  }
}

export function rememberedOrgs(provider: ProviderId): string[] {
  return read()[provider] ?? [];
}

// A mais recente primeiro; a mesma organização com outra caixa conta como uma só.
export function rememberOrg(provider: ProviderId, account: string) {
  const remembered = read();
  const others = (remembered[provider] ?? []).filter((name) => name.toLowerCase() !== account.toLowerCase());
  remembered[provider] = [account, ...others].slice(0, MAX_PER_PROVIDER);
  try {
    localStorage.setItem(KEY, JSON.stringify(remembered));
  } catch {
    // Sem armazenamento (aba privada): os atalhos valem só para esta visita.
  }
}
