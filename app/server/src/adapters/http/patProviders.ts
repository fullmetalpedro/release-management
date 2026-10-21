import type { AppConfig } from '../../config.ts';
import { ValidationError } from '../../core/domain/errors.ts';
import type { Person } from '../../core/domain/types.ts';
import { AzureDevOpsClient, basicFromPat } from '../azure-devops/client.ts';
import { AzureDevOpsSourceControl } from '../azure-devops/sourceControl.ts';
import { GitHubSourceControl } from '../github/sourceControl.ts';
import { JiraWorkTracking, parseJiraSite, resolveCloudId } from '../jira/workTracking.ts';
import type { Capability, PatProvider } from '../session/sessionStore.ts';
import { AzureDevOpsWorkTracking } from '../azure-devops/workTracking.ts';
import { parseGitHubOwner, parseOrganization } from './patTransport.ts';
import { msg } from '../../i18n.ts';

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
  // Escritas que o token não pode fazer (token só de leitura), descobertas na conexão.
  denied?: Capability[];
}

// Uma sondagem que falha não impede a conexão: sem resposta, a primeira escrita de verdade decide.
const probe = (run: () => Promise<boolean | undefined>) => run().catch(() => undefined);
const deniedOf = (results: [Capability, boolean | undefined][]) =>
  results.filter(([, allowed]) => allowed === false).map(([capability]) => capability);

// Confere o token na plataforma e devolve o dono dele; trocável nos testes.
export type PatValidator = (provider: PatProvider, input: PatInput) => Promise<PatValidation>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Lê e valida o que identifica a conta em cada plataforma. O valor vira parte de uma URL chamada pelo
// servidor, então cada um só aceita o formato do próprio provedor.
export function parseAccount(provider: PatProvider, body: { organization?: unknown; site?: unknown; email?: unknown }) {
  if (provider === 'azure-devops') return { account: parseOrganization(body.organization) };
  if (provider === 'github') return { account: parseGitHubOwner(body.organization) };
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!EMAIL.test(email)) throw new ValidationError(msg('atlassianEmailRequired'));
  return { account: parseJiraSite(body.site), email };
}

export function createPatValidator(config: AppConfig): PatValidator {
  const branching = { releasePattern: config.branching.releasePattern, developBranch: config.branching.developBranch };
  return async (provider, { account, token, email }) => {
    if (provider === 'azure-devops') {
      const client = new AzureDevOpsClient(account, async () => basicFromPat(token));
      const sourceControl = new AzureDevOpsSourceControl(client, branching);
      // A identidade sozinha não prova nada: o Azure DevOps responde como anônimo a um token inválido.
      // Listar projetos exige autenticação de verdade.
      const [project] = await sourceControl.listProjects();
      const owner = await sourceControl.currentUser();
      if (!project) return { owner };
      const tracking = new AzureDevOpsWorkTracking(client);
      const [code, work] = await Promise.all([
        probe(() => sourceControl.probeWriteAccess(project.id)),
        probe(() => tracking.probeWriteAccess(project.id)),
      ]);
      return { owner, denied: deniedOf([['createRelease', code], ['linkWorkItems', work]]) };
    }
    if (provider === 'github') {
      const sourceControl = new GitHubSourceControl({ owner: account, ...branching }, async () => token);
      const owner = await sourceControl.currentUser();
      // Confere também que o token enxerga a organização informada.
      await sourceControl.listRepositories(account);
      return { owner, denied: deniedOf([['createRelease', await probe(() => sourceControl.probeWriteAccess())]]) };
    }
    const cloudId = await resolveCloudId(account);
    const tracking = new JiraWorkTracking({ site: account, cloudId, email: email! }, async () => token);
    const owner = await tracking.currentUser();
    return { owner, cloudId, denied: deniedOf([['linkWorkItems', await probe(() => tracking.probeWriteAccess())]]) };
  };
}
