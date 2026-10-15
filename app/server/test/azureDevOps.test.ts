import { describe, expect, it } from 'vitest';
import { AzureDevOpsClient } from '../src/adapters/azure-devops/client.ts';
import {
  AzureDevOpsSourceControl,
  pullRequestIdsFromCommits,
  summarizePolicies,
  avatarKeyOf,
  toDecision,
} from '../src/adapters/azure-devops/sourceControl.ts';
import {
  AzureDevOpsWorkTracking,
  pullRequestArtifactUrl,
  toStateCategory,
} from '../src/adapters/azure-devops/workTracking.ts';
import { DEFAULT_RELEASE_PATTERN } from '../src/core/usecases/releaseNaming.ts';
import {
  CherryPickConflictError,
  NotAuthenticatedError,
  ProviderUnavailableError,
} from '../src/core/domain/errors.ts';

type Handler = (url: URL, init: RequestInit) => unknown;

// Fetch falso: casa "MÉTODO /caminho" por sufixo do pathname e registra as chamadas.
function fakeAzure(routes: Record<string, Handler>) {
  const calls: { method: string; path: string; query: URLSearchParams; body: unknown }[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = init.method ?? 'GET';
    const path = decodeURIComponent(url.pathname);
    calls.push({ method, path, query: url.searchParams, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((k) => {
      const [m, suffix] = k.split(' ');
      return m === method && path.endsWith(suffix!);
    });
    if (!key) return new Response(JSON.stringify({ message: `sem rota: ${method} ${path}` }), { status: 404, headers: { 'content-type': 'application/json' } });
    const result = routes[key]!(url, init);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new AzureDevOpsClient('acme', async () => 'Bearer token-123', fetchImpl);
  return { client, calls };
}

const repository = { id: 'repo-1', name: 'invoicing-api', projectId: 'proj-1' };
const options = { releasePattern: DEFAULT_RELEASE_PATTERN, developBranch: 'develop', cherryPickPollMs: 1 };
const identity = (id: string, displayName: string) => ({ id, displayName, uniqueName: `${id}@example.com` });

describe('cliente HTTP', () => {
  it('envia o bearer token e a versão da API', async () => {
    let seen: RequestInit | undefined;
    const { client, calls } = fakeAzure({
      'GET /_apis/projects': (_url, init) => {
        seen = init;
        return { value: [] };
      },
    });
    await client.get('/_apis/projects');
    expect((seen!.headers as Record<string, string>).Authorization).toBe('Bearer token-123');
    expect(calls[0]!.query.get('api-version')).toBe('7.1');
  });

  it('trata a página de login (203 HTML) como sessão inválida', async () => {
    const { client } = fakeAzure({
      'GET /_apis/projects': () => new Response('<html>Sign in</html>', { status: 203, headers: { 'content-type': 'text/html' } }),
    });
    await expect(client.get('/_apis/projects')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('traduz erro do servidor e falha de rede em provedor indisponível', async () => {
    const { client } = fakeAzure({
      'GET /_apis/projects': () => new Response(JSON.stringify({ message: 'TF400898' }), { status: 500, headers: { 'content-type': 'application/json' } }),
    });
    await expect(client.get('/_apis/projects')).rejects.toMatchObject({ status: 500, message: 'TF400898' });

    const offline = new AzureDevOpsClient('acme', async () => 'Bearer t', async () => {
      throw new TypeError('fetch failed');
    }, 1000, 2, 1);
    await expect(offline.get('/_apis/projects')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('token recusado chega como redirect ou página de login, não como JSON', async () => {
    const redirect = fakeAzure({
      'GET /_apis/projects': () => new Response('', { status: 302, headers: { location: 'https://spsprod.vssps.visualstudio.com/_signin' } }),
    });
    await expect(redirect.client.get('/_apis/projects')).rejects.toBeInstanceOf(NotAuthenticatedError);

    const html = fakeAzure({
      'GET /_apis/projects': () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    await expect(html.client.get('/_apis/projects')).rejects.toBeInstanceOf(NotAuthenticatedError);
  });

  it('repete leituras quando a conexão cai, mas nunca escritas', async () => {
    let calls = 0;
    const flaky = (failures: number) =>
      new AzureDevOpsClient('acme', async () => 'Bearer t', async () => {
        if (++calls <= failures) throw new TypeError('fetch failed');
        return Response.json({ value: [] });
      }, 1000, 2, 1);

    await expect(flaky(2).get('/_apis/projects')).resolves.toEqual({ value: [] });
    expect(calls).toBe(3);

    calls = 0;
    await expect(flaky(1).post('/_apis/git/refs', { body: [] })).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toBe(1);
  });
});

describe('pull requests', () => {
  it('traduz votos', () => {
    expect([10, 5, 0, -5, -10].map(toDecision)).toEqual(['approved', 'approved', 'pending', 'waiting-author', 'rejected']);
  });

  it('lê o mínimo de aprovações e o bloqueio das políticas de branch', () => {
    const policy = (status: string, isBlocking: boolean, minimumApproverCount?: number) => ({
      status,
      configuration: { isEnabled: true, isBlocking, settings: { minimumApproverCount } },
    });
    expect(summarizePolicies([policy('approved', true, 2), policy('rejected', false)])).toEqual({ requiredApprovals: 2, blockedByPolicy: false });
    expect(summarizePolicies([policy('queued', true, 2), policy('approved', true)])).toEqual({ requiredApprovals: 2, blockedByPolicy: true });
    expect(summarizePolicies([])).toEqual({ requiredApprovals: undefined, blockedByPolicy: false });
  });

  it('usa o descritor da identidade como chave da foto e só busca chaves bem formadas', async () => {
    expect(avatarKeyOf({ id: '1', displayName: 'A', descriptor: 'aad.ZTNjMTJlAbCdEf' })).toBe('aad.ZTNjMTJlAbCdEf');
    expect(
      avatarKeyOf({ id: '1', displayName: 'A', _links: { avatar: { href: 'https://dev.azure.com/acme/_apis/GraphProfile/MemberAvatars/aad.YWEzOTk5Zm9v?size=2' } } }),
    ).toBe('aad.YWEzOTk5Zm9v');
    expect(avatarKeyOf({ id: '1', displayName: 'A' })).toBeUndefined();
    expect(avatarKeyOf({ id: '1', displayName: 'A', descriptor: '../../etc/passwd' })).toBeUndefined();

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const { client, calls } = fakeAzure({
      'GET /_apis/GraphProfile/MemberAvatars/aad.ZTNjMTJlAbCdEf': () => new Response(png, { status: 200, headers: { 'content-type': 'image/png; api-version=7.1' } }),
      'GET /_apis/GraphProfile/MemberAvatars/aad.semFotoAbCdEf': () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
      'GET /_apis/GraphProfile/MemberAvatars/aad.recusadaAbCdEf': () => new Response('', { status: 401 }),
    });
    const sourceControl = new AzureDevOpsSourceControl(client, options);

    expect(await sourceControl.getAvatar('aad.ZTNjMTJlAbCdEf')).toEqual({ contentType: 'image/png', data: png });
    expect(await sourceControl.getAvatar('aad.semFotoAbCdEf')).toBeUndefined();
    // Token sem escopo para fotos: vira foto ausente, não sessão derrubada.
    expect(await sourceControl.getAvatar('aad.recusadaAbCdEf')).toBeUndefined();
    expect(await sourceControl.getAvatar('../../_apis/projects')).toBeUndefined();
    expect(calls).toHaveLength(3);
  });

  it('extrai os ids dos PRs das mensagens de commit', () => {
    const commits = [
      { comment: 'Merged PR 1284: feat: cadastro de centros de custo' },
      { comment: 'Merged PR 1282: fix: arredondamento\n\n(cherry picked from commit abc)' },
      { comment: 'Merged PR 1284: feat: cadastro de centros de custo' },
      { comment: 'ajuste manual' },
      {},
    ];
    expect(pullRequestIdsFromCommits(commits)).toEqual([1284, 1282]);
  });

  it('monta o PR canônico com comentários, conflitos e revisores sem grupos', async () => {
    const { client, calls } = fakeAzure({
      'GET /proj-1/_apis/git/pullrequests': () => ({
        value: [
          {
            pullRequestId: 642,
            title: 'fix: paginação',
            status: 'active',
            createdBy: identity('alex', 'Alex Rivera'),
            creationDate: '2026-10-10T12:00:00Z',
            sourceRefName: 'refs/heads/fix/paginacao',
            targetRefName: 'refs/heads/develop',
            mergeStatus: 'conflicts',
            reviewers: [
              { ...identity('sam', 'Sam Carter'), vote: -5, isRequired: true },
              { ...identity('ana', 'Amy Chen'), vote: 10 },
              { ...identity('team', '[Invoicing]\\Devs'), vote: 0, isContainer: true },
            ],
            repository: { id: 'repo-2', name: 'invoicing web', project: { id: 'proj-1' } },
          },
        ],
      }),
      'GET /pullRequests/642/threads': () => ({
        value: [
          { comments: [{ commentType: 'text' }] },
          { comments: [{ commentType: 'system' }] },
          { isDeleted: true, comments: [{ commentType: 'text' }] },
          { comments: [{ commentType: 'text', isDeleted: true }, { commentType: 'text' }] },
        ],
      }),
      'GET /pullRequests/642/conflicts': () => ({ value: [{}, {}, {}] }),
    });
    const [pr] = await new AzureDevOpsSourceControl(client, options).listOpenPullRequests('proj-1');

    expect(pr).toMatchObject({
      provider: 'azure-devops',
      id: 642,
      status: 'open',
      sourceBranch: 'fix/paginacao',
      targetBranch: 'develop',
      mergeState: 'conflicts',
      commentCount: 2,
      conflictCount: 3,
      author: { id: 'alex', name: 'Alex Rivera', email: 'alex@example.com' },
      webUrl: 'https://dev.azure.com/acme/proj-1/_git/invoicing%20web/pullrequest/642',
    });
    expect(pr!.reviews.map((r) => [r.reviewer.id, r.decision, r.required])).toEqual([
      ['sam', 'waiting-author', true],
      ['ana', 'approved', false],
    ]);
    expect(calls[0]!.query.get('searchCriteria.status')).toBe('active');
  });

  it('ignora PR de outro repositório citado numa mensagem de commit', async () => {
    const { client } = fakeAzure({
      'GET /pullrequests/1': () => ({
        pullRequestId: 1,
        title: 'a',
        status: 'completed',
        createdBy: identity('x', 'X'),
        creationDate: '2026-10-01T00:00:00Z',
        closedDate: '2026-10-02T00:00:00Z',
        sourceRefName: 'refs/heads/a',
        targetRefName: 'refs/heads/develop',
        repository: { id: 'repo-1', name: 'invoicing-api', project: { id: 'proj-1' } },
      }),
    });
    const found = await new AzureDevOpsSourceControl(client, options).getPullRequests(repository, [1, 999]);
    expect(found.map((pr) => [pr.id, pr.status, pr.closedAt])).toEqual([[1, 'merged', '2026-10-02T00:00:00Z']]);
  });

  it('acha os PRs da release pelos commits que ela tem a mais que a base', async () => {
    const { client } = fakeAzure({
      'GET /commits': (url) =>
        url.searchParams.get('searchCriteria.itemVersion.version') === 'release/2.15'
          ? { value: [{ commitId: 'c3', comment: 'Merged PR 7: x' }, { commitId: 'c2', comment: 'Merged PR 5: y' }, { commitId: 'c1', comment: 'Merged PR 3: z' }] }
          : { value: [{ commitId: 'c1', comment: 'Merged PR 3: z' }] },
    });
    const ids = await new AzureDevOpsSourceControl(client, options).listPullRequestIdsInBranch(repository, 'release/2.15', 'main');
    expect(ids).toEqual([7, 5]);
  });

  it('branch de comparação inexistente não quebra a listagem', async () => {
    const { client } = fakeAzure({
      'GET /commits': (url) =>
        url.searchParams.get('searchCriteria.itemVersion.version') === 'main'
          ? new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } })
          : { value: [{ commitId: 'c9', comment: 'Merged PR 9: x' }] },
    });
    const ids = await new AzureDevOpsSourceControl(client, options).listPullRequestIdsInBranch(repository, 'release/1.0', 'main');
    expect(ids).toEqual([9]);
  });
});

describe('branches de release', () => {
  it('pede as candidatas pelo trecho literal e filtra pelo padrão, da mais nova para a mais antiga', async () => {
    const { client, calls } = fakeAzure({
      'GET /refs': () => ({
        value: [
          'release-sprint-9',
          'release/131046-remover-ativo-filhas-dropdown',
          'release-sprint-35',
          'release/0.1.0',
          'release-sprint-35-hotfix',
          'releases-notes',
        ].map((name) => ({ name: 'refs/heads/' + name, objectId: name })),
      }),
      'GET /pushes': () => ({ value: [] }),
      'GET /stats/branches': () => ({ aheadCount: 3 }),
    });
    const branches = await new AzureDevOpsSourceControl(client, options).listReleaseBranches(repository);

    expect(branches.map((b) => b.name)).toEqual(['release-sprint-35', 'release-sprint-9', 'release/0.1.0']);
    expect(calls[0]!.query.get('filter')).toBe('heads/release');
  });
});

describe('branch base', () => {
  it('só aceita nome exato, não prefixo', async () => {
    const { client } = fakeAzure({
      'GET /refs': (url) => ({
        value: url.searchParams.get('filter') === 'heads/master'
          ? [{ name: 'refs/heads/master', objectId: 'a' }]
          : [{ name: 'refs/heads/main-old', objectId: 'b' }],
      }),
    });
    const found = await new AzureDevOpsSourceControl(client, options).existingBranches(repository, ['main', 'master']);
    expect(found).toEqual(['master']);
  });
});

describe('criação da branch de release', () => {
  function cherryPickFake(outcomes: Record<number, 'completed' | 'conflict' | 'failed'>) {
    const refs = new Map<string, string>([['refs/heads/main', 'sha-main']]);
    const picks = new Map<number, { pullRequestId: number; generated: string; polls: number }>();
    let nextId = 100;
    const fake = fakeAzure({
      'POST /cherryPicks': (_url, init) => {
        const body = JSON.parse(String(init.body)) as { generatedRefName: string; ontoRefName: string; source: { pullRequestId: number } };
        if (!refs.has(body.ontoRefName)) return new Response('{}', { status: 400, headers: { 'content-type': 'application/json' } });
        const id = nextId++;
        picks.set(id, { pullRequestId: body.source.pullRequestId, generated: body.generatedRefName, polls: 0 });
        return { cherryPickId: id, status: 'queued' };
      },
      'GET /refs': (url) => {
        const prefix = `refs/${url.searchParams.get('filter')}`;
        return { value: [...refs].filter(([name]) => name.startsWith(prefix)).map(([name, objectId]) => ({ name, objectId })) };
      },
      'POST /refs': (_url, init) => {
        const updates = JSON.parse(String(init.body)) as { name: string; oldObjectId: string; newObjectId: string }[];
        for (const update of updates) {
          if (/^0+$/.test(update.newObjectId)) refs.delete(update.name);
          else refs.set(update.name, update.newObjectId);
        }
        return { value: updates.map((u) => ({ name: u.name, success: true })) };
      },
    });
    // Rota dinâmica: o status do cherry-pick avança a cada consulta.
    const original = fake.client['fetchImpl' as never] as (input: string, init?: RequestInit) => Promise<Response>;
    (fake.client as unknown as { fetchImpl: typeof original }).fetchImpl = async (input, init) => {
      const match = new URL(input).pathname.match(/\/cherryPicks\/(\d+)$/);
      if (!match || (init?.method ?? 'GET') !== 'GET') return original(input, init);
      const id = Number(match[1]);
      const pick = picks.get(id)!;
      pick.polls++;
      const outcome = outcomes[pick.pullRequestId] ?? 'completed';
      let body: unknown = { cherryPickId: id, status: 'inProgress' };
      if (pick.polls >= 2) {
        if (outcome === 'completed') {
          refs.set(pick.generated, `sha-after-${pick.pullRequestId}`);
          body = { cherryPickId: id, status: 'completed' };
        } else {
          body = {
            cherryPickId: id,
            status: 'failed',
            detailedStatus: outcome === 'conflict' ? { conflict: true } : { failureMessage: 'TF401027: sem permissão' },
          };
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { ...fake, refs };
  }

  const input = { repository, name: 'release/2.16', baseBranch: 'main', pullRequestIds: [1291, 1294, 1295] };
  const me = { 'GET /_apis/connectionData': () => ({ authenticatedUser: { id: 'alex', providerDisplayName: 'Alex Rivera' } }) };

  it('encadeia os cherry-picks, cria a release no último commit e apaga as temporárias', async () => {
    const { client, calls, refs } = cherryPickFake({});
    // connectionData é consultado para o "criada por".
    const withMe = client as unknown as { fetchImpl: (input: string, init?: RequestInit) => Promise<Response> };
    const inner = withMe.fetchImpl;
    withMe.fetchImpl = async (url, init) =>
      url.includes('connectionData')
        ? new Response(JSON.stringify(me['GET /_apis/connectionData']()), { status: 200, headers: { 'content-type': 'application/json' } })
        : inner(url, init);

    const branch = await new AzureDevOpsSourceControl(client, options).createReleaseBranch(input);

    expect(branch).toMatchObject({ name: 'release/2.16', baseBranch: 'main', createdBy: { id: 'alex' } });
    expect(Object.fromEntries(refs)).toEqual({ 'refs/heads/main': 'sha-main', 'refs/heads/release/2.16': 'sha-after-1295' });

    const picks = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cherryPicks')).map((c) => c.body as { ontoRefName: string; generatedRefName: string; source: unknown });
    expect(picks.map((p) => p.source)).toEqual([{ pullRequestId: 1291 }, { pullRequestId: 1294 }, { pullRequestId: 1295 }]);
    expect(picks[0]!.ontoRefName).toBe('refs/heads/main');
    expect(picks[1]!.ontoRefName).toBe(picks[0]!.generatedRefName);
    expect(picks[2]!.ontoRefName).toBe(picks[1]!.generatedRefName);
  });

  it('em conflito não cria a release e limpa o que já tinha aplicado', async () => {
    const { client, refs, calls } = cherryPickFake({ 1294: 'conflict' });
    const attempt = new AzureDevOpsSourceControl(client, options).createReleaseBranch(input);

    await expect(attempt).rejects.toBeInstanceOf(CherryPickConflictError);
    await expect(attempt).rejects.toMatchObject({ pullRequestId: 1294, baseBranch: 'main' });
    expect(Object.fromEntries(refs)).toEqual({ 'refs/heads/main': 'sha-main' });
    expect(calls.filter((c) => c.method === 'POST' && c.path.endsWith('/cherryPicks'))).toHaveLength(2);
  });

  it('outras falhas viram erro do provedor com a mensagem dele', async () => {
    const { client, refs } = cherryPickFake({ 1291: 'failed' });
    const attempt = new AzureDevOpsSourceControl(client, options).createReleaseBranch(input);
    await expect(attempt).rejects.toThrow('TF401027');
    expect(refs.has('refs/heads/release/2.16')).toBe(false);
  });
});

describe('work items', () => {
  it('classifica estados pelo nome e pela categoria do processo', () => {
    expect(toStateCategory('Em teste', 'InProgress')).toBe('testing');
    expect(toStateCategory('Concluída', 'Completed')).toBe('done');
    expect(toStateCategory('Em andamento', 'InProgress')).toBe('in-progress');
    expect(toStateCategory('Novo', 'Proposed')).toBe('todo');
    expect(toStateCategory('Done', undefined)).toBe('done');
  });

  it('carrega os work items do PR com o PBI pai', async () => {
    const wi = (id: number, type: string, title: string, state: string, parent?: number) => ({
      id,
      fields: { 'System.Title': title, 'System.WorkItemType': type, 'System.State': state, 'System.TeamProject': 'Invoicing', 'System.Parent': parent },
    });
    const { client, calls } = fakeAzure({
      'GET /pullRequests/1284/workitems': () => ({ value: [{ id: '48125' }] }),
      'POST /_apis/wit/workitemsbatch': (_url, init) => {
        const { ids } = JSON.parse(String(init.body)) as { ids: number[] };
        const all = [wi(48125, 'Task', 'Cadastro de centros de custo (API)', 'Concluída', 48120), wi(48120, 'Product Backlog Item', 'Centros de custo', 'Em teste')];
        return { value: all.filter((w) => ids.includes(w.id)) };
      },
      'GET /workitemtypes/Task/states': () => ({ value: [{ name: 'Concluída', category: 'Completed' }] }),
      'GET /workitemtypes/Product Backlog Item/states': () => ({ value: [{ name: 'Em teste', category: 'InProgress' }] }),
    });
    const items = await new AzureDevOpsWorkTracking(client).listWorkItemsForPullRequest({ projectId: 'proj-1', repositoryId: 'repo-1', pullRequestId: 1284 });

    expect(items).toEqual([
      {
        id: 48125,
        title: 'Cadastro de centros de custo (API)',
        kind: 'task',
        state: { name: 'Concluída', category: 'done' },
        webUrl: 'https://dev.azure.com/acme/_workitems/edit/48125',
        parent: {
          id: 48120,
          title: 'Centros de custo',
          kind: 'pbi',
          state: { name: 'Em teste', category: 'testing' },
          webUrl: 'https://dev.azure.com/acme/_workitems/edit/48120',
        },
      },
    ]);
    expect(calls.filter((c) => c.path.endsWith('/states'))).toHaveLength(2);
  });

  it('busca por título escapando aspas, e por id quando o termo é numérico', async () => {
    const { client, calls } = fakeAzure({ 'POST /_apis/wit/wiql': () => ({ workItems: [] }) });
    const tracking = new AzureDevOpsWorkTracking(client);
    await tracking.searchWorkItems('proj-1', "d'água");
    await tracking.searchWorkItems('proj-1', '48181');
    const queries = calls.map((c) => (c.body as { query: string }).query);
    expect(queries[0]).toContain("[System.Title] CONTAINS 'd''água'");
    expect(queries[1]).toContain('[System.Id] = 48181');
  });

  it('vincula e desvincula o PR pelo artifact link', async () => {
    const ref = { projectId: 'proj-1', repositoryId: 'repo-1', pullRequestId: 1274 };
    const url = pullRequestArtifactUrl(ref);
    expect(url).toBe('vstfs:///Git/PullRequestId/proj-1%2Frepo-1%2F1274');

    const { client, calls } = fakeAzure({
      'PATCH /_apis/wit/workitems/48181': () => ({}),
      'GET /_apis/wit/workitems/48181': () => ({
        id: 48181,
        fields: {},
        relations: [
          { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'x' },
          { rel: 'ArtifactLink', url: url.toUpperCase().replace('VSTFS', 'vstfs') },
        ],
      }),
    });
    const tracking = new AzureDevOpsWorkTracking(client);

    await tracking.linkPullRequest(48181, ref);
    expect(calls[0]!.body).toEqual([
      { op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url, attributes: { name: 'Pull Request' } } },
    ]);

    await tracking.unlinkPullRequest(48181, ref);
    expect(calls.at(-1)!.body).toEqual([{ op: 'remove', path: '/relations/1' }]);
  });
});
