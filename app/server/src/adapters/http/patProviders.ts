import type { AppConfig } from '../../config.ts';
import { ValidationError } from '../../core/domain/errors.ts';
import type { Person } from '../../core/domain/types.ts';
import { AzureDevOpsClient, basicFromPat } from '../azure-devops/client.ts';
import { AzureDevOpsSourceControl } from '../azure-devops/sourceControl.ts';
import { GitHubSourceControl } from '../github/sourceControl.ts';
import { JiraWorkTracking, parseJiraSite, resolveCloudId } from '../jira/workTracking.ts';
import type { PatProvider } from '../session/sessionStore.ts';
import { parseGitHubOwner, parseOrganization } from './patTransport.ts';

export const PAT_PROVIDERS: PatProvider[] = ['azure-devops', 'github', 'jira'];

export const PROVIDER_LABELS: Record<PatProvider, string> = {
  'azure-devops': 'Azure DevOps',
  github: 'GitHub',
  jira: 'Jira',
};

export interface PatInput {
  // Organização (Azure DevOps), dono (GitHub) ou site (Jira), já validado.
  account: string;
  token: string;
  email?: string;
}

export interface PatValidation {
  owner: Person;
  cloudId?: string;
}

// Confere o token na plataforma e devolve o dono dele; trocável nos testes.
export type PatValidator = (provider: PatProvider, input: PatInput) => Promise<PatValidation>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lê e valida o que identifica a conta em cada plataforma. O valor vira parte de uma URL chamada pelo
// servidor, então cada um só aceita o formato do próprio provedor.
export function parseAccount(provider: PatProvider, body: { organization?: unknown; site?: unknown; email?: unknown }) {
  if (provider === 'azure-devops') return { account: parseOrganization(body.organization) };
  if (provider === 'github') return { account: parseGitHubOwner(body.organization) };
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!EMAIL.test(email)) throw new ValidationError('Informe o e-mail da sua conta Atlassian.');
  return { account: parseJiraSite(body.site), email };
}

export function createPatValidator(config: AppConfig): PatValidator {
  const branching = { releasePattern: config.branching.releasePattern, developBranch: config.branching.developBranch };
  return async (provider, { account, token, email }) => {
    if (provider === 'azure-devops') {
      const sourceControl = new AzureDevOpsSourceControl(new AzureDevOpsClient(account, async () => basicFromPat(token)), branching);
      // A identidade sozinha não prova nada: o Azure DevOps responde como anônimo a um token inválido.
      // Listar projetos exige autenticação de verdade.
      await sourceControl.listProjects();
      return { owner: await sourceControl.currentUser() };
    }
    if (provider === 'github') {
      const sourceControl = new GitHubSourceControl({ owner: account, ...branching }, async () => token);
      const owner = await sourceControl.currentUser();
      // Confere também que o token enxerga a organização informada.
      await sourceControl.listRepositories(account);
      return { owner };
    }
    const cloudId = await resolveCloudId(account);
    const owner = await new JiraWorkTracking({ site: account, cloudId, email: email! }, async () => token).currentUser();
    return { owner, cloudId };
  };
}
