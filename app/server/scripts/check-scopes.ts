// Confere, com um token de verdade, se os escopos do guia de token bastam para tudo o que o app faz. Usa os mesmos
// adapters e casos de uso do servidor, com um fetch que registra cada requisição ao provedor: no fim sai a lista
// de chamadas com o status e, nas recusadas, o escopo que costuma faltar.
//
//   cd app/server
//   npx tsx scripts/check-scopes.ts azure-devops <organização> [projeto]
//   npx tsx scripts/check-scopes.ts github <organização ou usuário>
//   npx tsx scripts/check-scopes.ts jira <site.atlassian.net> <e-mail>
//
// O token é pedido no terminal, sem eco, ou lido de RM_TOKEN. Por padrão só lê. Com --write, testa também as
// escritas, sempre desfazendo em seguida:
//   Azure DevOps / GitHub: cria e apaga a branch rm-scope-check/<aleatório> a partir da develop (ou da padrão).
//   Azure DevOps: vincula e desvincula um work item de um PR (RM_WORKITEM e RM_PR, ids existentes).
//   Jira: vincula e desvincula um link remoto numa issue (RM_ISSUE, ex.: ABC-123).
import { randomBytes } from 'node:crypto';
import { AzureDevOpsClient, basicFromPat } from '../src/adapters/azure-devops/client.ts';
import { AzureDevOpsSourceControl } from '../src/adapters/azure-devops/sourceControl.ts';
import { AzureDevOpsWorkTracking } from '../src/adapters/azure-devops/workTracking.ts';
import { GitHubSourceControl } from '../src/adapters/github/sourceControl.ts';
import { createPatValidator } from '../src/adapters/http/patProviders.ts';
import { JiraWorkTracking, parseJiraSite, resolveCloudId } from '../src/adapters/jira/workTracking.ts';
import type { PatProvider } from '../src/adapters/session/sessionStore.ts';
import { loadConfig } from '../src/config.ts';
import { LocalizedError } from '../src/core/domain/errors.ts';
import type { SourceControl } from '../src/core/ports/sourceControl.ts';
import type { WorkTracking } from '../src/core/ports/workTracking.ts';
import { getBoard } from '../src/core/usecases/board.ts';
import { listProjects } from '../src/core/usecases/projects.ts';
import { getReleaseDetails } from '../src/core/usecases/releaseDetails.ts';
import { getReleaseLanes } from '../src/core/usecases/releaseLane.ts';
import { linkWorkItem, searchWorkItems, unlinkWorkItem } from '../src/core/usecases/workItems.ts';

const args = process.argv.slice(2).filter((arg) => arg !== '--write');
const write = process.argv.includes('--write');
const [provider, account, extra] = args as [PatProvider | undefined, string | undefined, string | undefined];
if (!provider || !account || !['azure-devops', 'github', 'jira'].includes(provider) || (provider === 'jira' && !extra)) {
  console.error('Uso: npx tsx scripts/check-scopes.ts <azure-devops|github|jira> <conta> [projeto | e-mail] [--write]');
  process.exit(2);
}

// ---- Registro das chamadas ----

// 401/403, redirect para o login (Azure DevOps) e erro de permissão dentro do GraphQL (marcado como 299).
const isRefused = (call: { status: number; probe?: boolean }) => !call.probe && (call.status === 401 || call.status === 403 || call.status === 299 || (call.status >= 300 && call.status < 400));

interface Call {
  // Sondagem de escrita do app: a recusa é esperada com token só de leitura e não conta como falha.
  probe?: boolean;
  method: string;
  path: string;
  status: number;
  detail?: string;
}
const calls: Call[] = [];
const realFetch = globalThis.fetch;

const loggingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const response = await realFetch(input, init);
  const body = typeof init?.body === 'string' ? init.body : '';
  const call: Call = {
    method: (init?.method ?? 'GET').toUpperCase(),
    path: url.hostname + url.pathname,
    status: response.status,
    probe: body.includes('rm-access-probe') || url.pathname.includes('RMPROBE') || url.searchParams.get('validateOnly') === 'true',
  };
  if (response.status >= 300 && response.status < 400) {
    call.detail = `redirect para ${response.headers.get('location')?.split('?')[0] ?? 'o login'}: o token foi recusado`;
  } else if (!response.ok) {
    const body = await response.clone().text().catch(() => '');
    call.detail = (body.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? body.replace(/\s+/g, ' ')).slice(0, 220);
  } else if (url.pathname.endsWith('/graphql')) {
    // O GraphQL responde 200 mesmo quando um campo é negado: o erro vem no corpo.
    const body = await response.clone().json().catch(() => ({})) as { errors?: { message: string }[] };
    if (body.errors?.length) {
      call.status = 299;
      call.detail = body.errors.map((error) => error.message).join(' | ').slice(0, 220);
    }
  } else if (url.hostname === 'dev.azure.com' && !(response.headers.get('content-type') ?? '').includes('json') && !url.pathname.includes('Avatars')) {
    call.detail = 'Resposta em HTML (página de login): o Azure DevOps recusou o token';
  }
  calls.push(call);
  return response;
};

// Escopo que costuma faltar quando a chamada é recusada, pela documentação de cada provedor.
function scopeHint(call: Call): string {
  const { method, path } = call;
  if (provider === 'azure-devops') {
    if (path.endsWith('/_apis/connectionData')) return 'sem escopo documentado (identifica o dono do token)';
    if (path.includes('GraphProfile/MemberAvatars')) return 'sem escopo documentado (foto de perfil)';
    if (path.endsWith('/_apis/projects')) return 'Project and Team (Read)';
    if (path.includes('/_apis/wit/')) return method === 'PATCH' ? 'Work Items (Read & Write)' : 'Work Items (Read)';
    if (path.includes('/_apis/policy/')) return 'Code (Read)';
    if (path.includes('/_apis/git/')) return method === 'GET' ? 'Code (Read)' : 'Code (Read & Write)';
    return '?';
  }
  if (provider === 'github') {
    if (path.endsWith('/user')) return 'nenhum';
    if (path.endsWith('/graphql')) return 'Pull requests (Read) + Metadata (Read)';
    if (/\/(orgs\/[^/]+|user)\/repos$/.test(path)) return 'Metadata (Read)';
    if (path.includes('/pulls')) return 'Pull requests (Read)';
    if (path.includes('/repos/')) return method === 'GET' ? 'Contents (Read)' : 'Contents (Read and write)';
    return '?';
  }
  if (path.endsWith('/myself')) return 'read:jira-user';
  if (path.includes('/remotelink') && method !== 'GET') return 'write:jira-work';
  if (path.includes('/rest/api/3/')) return 'read:jira-work';
  return 'público';
}

// ---- Passos ----

const results: { step: string; ok: boolean; note: string }[] = [];
async function step<T>(name: string, run: () => Promise<T>, describe?: (value: T) => string): Promise<T | undefined> {
  const before = calls.length;
  try {
    const value = await run();
    const refused = calls.slice(before).filter(isRefused);
    // Vários adapters tratam 403/404 como "não existe" e seguem em frente: a recusa só aparece no registro.
    results.push({ step: name, ok: refused.length === 0, note: refused.length ? `concluiu, mas ${refused.length} chamada(s) recusada(s) foram ignoradas` : (describe?.(value) ?? 'ok') });
    return value;
  } catch (error) {
    const message = error instanceof LocalizedError ? error.messageIn('pt') : (error as Error).message;
    results.push({ step: name, ok: false, note: message });
    return undefined;
  }
}

async function askToken(): Promise<string> {
  if (process.env.RM_TOKEN?.trim()) return process.env.RM_TOKEN.trim();
  // Lê caractere a caractere, sem eco. Linha vazia (um Enter que sobrou no terminal) não conta: pergunta de novo.
  for (;;) {
    process.stdout.write('Cole o token e tecle Enter (não aparece ao digitar): ');
    const answer = await new Promise<string>((resolve) => {
      let typed = '';
      const stdin = process.stdin;
      stdin.setRawMode?.(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === '\u0003') process.exit(130);
          if (char === '\r' || char === '\n') {
            stdin.off('data', onData);
            stdin.setRawMode?.(false);
            stdin.pause();
            process.stdout.write('\n');
            return resolve(typed.trim());
          }
          if (char === '\u0008' || char === '\u007f') typed = typed.slice(0, -1);
          else typed += char;
        }
      };
      stdin.on('data', onData);
    });
    if (answer.length >= 20) return answer;
    if (answer) console.log('Isso não parece um token (curto demais). Tente de novo.');
  }
}

const token = await askToken();
const config = loadConfig({ ...process.env, AZDO_ORG: provider === 'azure-devops' ? account : '' });
const branching = { releasePattern: config.branching.releasePattern, developBranch: config.branching.developBranch };
// O validador do app faz as chamadas sem o fetch registrado; troca o global só durante a conexão.
globalThis.fetch = loggingFetch as typeof fetch;

await step('Conectar (a mesma validação da tela de token)', async () => {
  const email = provider === 'jira' ? extra : undefined;
  const site = provider === 'jira' ? parseJiraSite(account) : account;
  return createPatValidator(config)(provider, { account: site, token, email });
}, ({ owner, denied }) =>
  `dono do token: ${owner.name}${owner.email ? ` <${owner.email}>` : ''} · ` +
  (denied?.length ? `só leitura para: ${denied.join(', ')}` : 'escritas permitidas (ou sem resposta da sondagem)'),
);

globalThis.fetch = realFetch;

if (provider === 'jira') {
  const site = parseJiraSite(account);
  const cloudId = await resolveCloudId(site);
  const tracking = new JiraWorkTracking({ site, cloudId, email: extra! }, async () => token, loggingFetch as typeof fetch);
  await step('Buscar issues (vincular PR)', () => tracking.searchWorkItems('', process.env.RM_TERM ?? 'a'), (items) => `${items.length} issue(s)`);
  const issue = process.env.RM_ISSUE;
  if (issue) {
    const ref = { projectId: 'acme', repositoryId: 'rm-scope-check', pullRequestId: 999_999, title: 'rm scope check', webUrl: 'https://github.com/acme/rm-scope-check/pull/999999' };
    await step(`Ler a issue ${issue} pelos PRs`, () => tracking.listWorkItemsForPullRequest({ ...ref, title: `${issue} rm scope check` }), (items) => `${items.length} issue(s)`);
    if (write) {
      const id = Number((await tracking.searchWorkItems('', issue)).find((item) => item.key === issue)?.id);
      await step(`Vincular e desvincular um link remoto em ${issue}`, async () => {
        await tracking.linkPullRequest(id, ref);
        await tracking.unlinkPullRequest(id, ref);
      });
    }
  }
} else {
  let sourceControl: SourceControl;
  let workTracking: WorkTracking | undefined;
  let client: AzureDevOpsClient | undefined;
  if (provider === 'azure-devops') {
    client = new AzureDevOpsClient(account, async () => basicFromPat(token), loggingFetch as typeof fetch);
    sourceControl = new AzureDevOpsSourceControl(client, branching);
    workTracking = new AzureDevOpsWorkTracking(client);
  } else {
    sourceControl = new GitHubSourceControl({ owner: account, ...branching }, async () => token, loggingFetch as typeof fetch);
  }
  const connection = { sourceControl, workTracking: workTracking! };

  const me = await step('Identificar o usuário', async () => {
    const person = await sourceControl.currentUser();
    // Sem acesso, o Azure DevOps responde 200 com um usuário anônimo em vez de recusar.
    if (/^anonymous$/i.test(person.name)) throw new Error('o provedor respondeu como usuário anônimo: o token não foi aceito');
    return person;
  }, (person) => person.name);
  if (me?.avatarKey) {
    await step('Foto de perfil', () => sourceControl.getAvatar(me.avatarKey!), (avatar) => (avatar ? 'ok' : 'sem foto (ver a chamada abaixo)'));
  }
  const projects = (await step('Listar projetos', () => listProjects(connection), (list) => `${list.length} projeto(s)`)) ?? [];
  const project = projects.find((p) => p.name === extra || p.id === extra) ?? projects.find((p) => p.openPullRequests > 0) ?? projects[0];
  if (project) {
    await step(`Board de ${project.name}`, () => getBoard(connection, project.id), (board) =>
      `${Object.values(board.columns).reduce((total, cards) => total + cards.length, 0)} PR(s) aberto(s)`,
    );
    const lanes = await step(`Raias de release de ${project.name}`, () => getReleaseLanes(connection, { projectId: project.id, branching: config.branching }), (result) =>
      `${result.lanes.length} repositório(s)`,
    );
    const lane = lanes?.lanes.find((candidate) => candidate.release) ?? lanes?.lanes[0];
    if (lane && workTracking) {
      await step(`Tela da release de ${lane.repository.name}`, () =>
        getReleaseDetails(connection, { projectId: project.id, repositoryId: lane.repository.id, branching: config.branching }),
      );
      await step('Buscar work items', () => searchWorkItems(connection, { projectId: project.id, term: process.env.RM_TERM ?? 'te' }), (items) => `${items.length} item(ns)`);
    }

    if (write && lane) {
      const repositories = await sourceControl.listRepositories(project.id);
      const repository = repositories.find((repo) => repo.id === lane.repository.id)!;
      const [base] = await sourceControl.existingBranches(repository, [branching.developBranch, 'main', 'master']);
      const name = `rm-scope-check/${randomBytes(3).toString('hex')}`;
      if (!base) {
        results.push({ step: 'Criar e apagar uma branch', ok: false, note: 'nenhuma branch develop, main ou master no repositório' });
      } else if (client) {
        const repoPath = `/${encodeURIComponent(project.id)}/_apis/git/repositories/${encodeURIComponent(repository.id)}`;
        await step(`Criar e apagar a branch ${name} (a partir de ${base})`, async () => {
          const { value } = await client!.get<{ value: { objectId: string }[] }>(`${repoPath}/refs`, { query: { filter: `heads/${base}` } });
          const tip = value[0]!.objectId;
          const zero = '0'.repeat(40);
          const created = await client!.post<{ value: { success: boolean; customMessage?: string }[] }>(`${repoPath}/refs`, {
            body: [{ name: `refs/heads/${name}`, oldObjectId: zero, newObjectId: tip }],
          });
          if (!created.value[0]?.success) throw new Error(`branch não criada: ${created.value[0]?.customMessage ?? 'sem detalhe'}`);
          const removed = await client!.post<{ value: { success: boolean; customMessage?: string }[] }>(`${repoPath}/refs`, {
            body: [{ name: `refs/heads/${name}`, oldObjectId: tip, newObjectId: zero }],
          });
          if (!removed.value[0]?.success) throw new Error(`branch criada mas não apagada (apague ${name} à mão): ${removed.value[0]?.customMessage ?? ''}`);
        });
      } else {
        const repo = `https://api.github.com/repos/${encodeURIComponent(account)}/${encodeURIComponent(repository.name)}`;
        const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'release-management' };
        await step(`Criar e apagar a branch ${name} (a partir de ${base})`, async () => {
          const ref = await loggingFetch(`${repo}/git/ref/heads/${encodeURIComponent(base)}`, { headers });
          const sha = ((await ref.json()) as { object: { sha: string } }).object.sha;
          const created = await loggingFetch(`${repo}/git/refs`, { method: 'POST', headers, body: JSON.stringify({ ref: `refs/heads/${name}`, sha }) });
          if (!created.ok) throw new Error(`branch não criada (HTTP ${created.status})`);
          const removed = await loggingFetch(`${repo}/git/refs/heads/${name}`, { method: 'DELETE', headers });
          if (!removed.ok) throw new Error(`branch criada mas não apagada (apague ${name} à mão), HTTP ${removed.status}`);
        });
      }

      const workItemId = Number(process.env.RM_WORKITEM);
      const pullRequestId = Number(process.env.RM_PR);
      if (workTracking && workItemId && pullRequestId) {
        const ref = { projectId: project.id, repositoryId: repository.id, pullRequestId };
        await step(`Vincular e desvincular o work item ${workItemId} do PR ${pullRequestId}`, async () => {
          const already = (await workTracking!.listWorkItemsForPullRequest(ref)).some((item) => item.id === workItemId);
          if (already) throw new Error('o work item já está vinculado a esse PR; escolha outro par para o teste não desfazer um vínculo real');
          await linkWorkItem(connection, workItemId, ref);
          await unlinkWorkItem(connection, workItemId, ref);
        });
      }
    }
  }
}

// ---- Relatório ----

console.log('\nPassos do app');
for (const result of results) console.log(`  ${result.ok ? '✓' : '✗'} ${result.step}: ${result.note}`);

const seen = new Map<string, Call & { count: number }>();
for (const call of calls) {
  // Ids e nomes viram * para agrupar a mesma chamada feita em vários PRs e repositórios.
  const shape = call.path.replace(/\/[0-9a-f-]{36}/gi, '/*').replace(/\/\d+(?=\/|$)/g, '/*');
  const key = `${call.method} ${shape} ${call.status}${call.probe ? " probe" : ""}`;
  const current = seen.get(key);
  if (current) current.count++;
  else seen.set(key, { ...call, path: shape, count: 1 });
}
console.log('\nChamadas ao provedor');
for (const call of seen.values()) {
  const refused = isRefused(call);
  const mark = call.probe ? '?' : refused ? '✗' : call.status >= 400 ? '!' : '✓';
  console.log(`  ${mark} ${call.status === 299 ? 'GQL' : call.status} ${call.method} ${call.path}${call.count > 1 ? ` (×${call.count})` : ''}${call.probe ? ' (sondagem de escrita)' : ''}`);
  if (!call.probe && (refused || call.status >= 400)) console.log(`      escopo: ${scopeHint(call)}${call.detail ? `\n      provedor: ${call.detail}` : ''}`);
}
const failed = results.some((result) => !result.ok);
console.log(failed ? '\nAlgo foi recusado: veja acima qual chamada e o escopo provável.' : '\nTudo passou com este token.');
process.exit(failed ? 1 : 0);
