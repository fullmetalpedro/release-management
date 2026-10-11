// Teste de leitura do adapter do Azure DevOps contra a organização real. Não grava nada.
// Uso: AZDO_ORG=<org> AZDO_PAT=<pat> [AZDO_PROJECTS=a,b] npx tsx scripts/smoke-readonly.ts
// O PAT serve só a este diagnóstico; a aplicação usa o token do login com Microsoft.
import { AzureDevOpsClient, basicFromPat } from '../src/adapters/azure-devops/client.ts';
import { AzureDevOpsSourceControl } from '../src/adapters/azure-devops/sourceControl.ts';
import { AzureDevOpsWorkTracking } from '../src/adapters/azure-devops/workTracking.ts';
import { loadConfig } from '../src/config.ts';
import { getBoard } from '../src/core/usecases/board.ts';
import { listProjects } from '../src/core/usecases/projects.ts';
import { getReleaseDetails } from '../src/core/usecases/releaseDetails.ts';
import { getReleaseLane } from '../src/core/usecases/releaseLane.ts';

const organization = process.env.AZDO_ORG;
const pat = process.env.AZDO_PAT;
if (!organization || !pat) {
  console.error('Defina AZDO_ORG e AZDO_PAT.');
  process.exit(1);
}

const { branching, projects: allowed } = loadConfig({ ...process.env, AUTH_MODE: 'demo' });
// Escritas são barradas: o teste só lê.
const client = new AzureDevOpsClient(organization, async () => basicFromPat(pat), async (url, init = {}) => {
  const readOnlyPost = /\/_apis\/wit\/(wiql|workitemsbatch)/.test(url);
  if ((init.method ?? 'GET') !== 'GET' && !readOnlyPost) throw new Error(`escrita bloqueada no teste: ${init.method} ${url}`);
  return fetch(url, init);
});
const sourceControl = new AzureDevOpsSourceControl(client, branching);
const workTracking = new AzureDevOpsWorkTracking(client);

const step = async <T>(label: string, run: () => Promise<T>, show: (value: T) => string): Promise<T | undefined> => {
  try {
    const value = await run();
    console.log(`ok    ${label}: ${show(value)}`);
    return value;
  } catch (error) {
    console.log(`FALHA ${label}: ${(error as Error).message}`);
    process.exitCode = 1;
    return undefined;
  }
};

await step('usuário', () => sourceControl.currentUser(), (me) => `${me.name} <${me.email ?? '?'}>`);
const projects = await step('projetos', () => listProjects({ sourceControl }, allowed), (list) =>
  list.map((p) => `${p.name} (${p.openPullRequests})`).join(', '),
);

for (const project of projects ?? []) {
  const board = await step(`board ${project.name}`, () => getBoard({ sourceControl }, project.id), (b) =>
    `${b.openCount} abertos · ` + Object.entries(b.columns).map(([k, v]) => `${k}=${v.length}`).join(' '),
  );
  for (const repository of (board?.repositories ?? []).slice(0, Number(process.env.SMOKE_REPOS ?? 3))) {
    const input = { projectId: project.id, repositoryId: repository.id, branching };
    const lane = await step(`  lane ${repository.name}`, () => getReleaseLane({ sourceControl }, input), (l) =>
      `${l.merged.length} mergeados · release ${l.release?.name ?? '—'} (${l.release?.pullRequests.length ?? 0} PRs) · próxima ${l.suggestedBranch}`,
    );
    if (lane?.release) {
      await step(`  release ${repository.name}`, () => getReleaseDetails({ sourceControl, workTracking }, input), (d) =>
        `${d.summary.pullRequests} PRs · ${d.summary.tasks} tasks · ${d.summary.pbis} PBIs · ${d.summary.unlinked} sem task`,
      );
    }
  }
  await step(`  busca de tasks em ${project.name}`, () => workTracking.searchWorkItems(project.id, 'a'), (w) => `${w.length} resultados`);
}
