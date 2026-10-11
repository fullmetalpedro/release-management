import { describe, expect, it } from 'vitest';
import {
  GitHubSourceControl,
  pullRequestIdsFromMessages,
  toReviews,
} from '../src/adapters/github/sourceControl.ts';
import {
  issueKeysFrom,
  JiraWorkTracking,
  NoWorkTracking,
  parseJiraSite,
  remoteLinkGlobalId,
  resolveCloudId,
} from '../src/adapters/jira/workTracking.ts';
import { CherryPickConflictError, NotAuthenticatedError, ValidationError } from '../src/core/domain/errors.ts';
import { classify } from '../src/core/usecases/board.ts';
import { DEFAULT_RELEASE_PATTERN } from '../src/core/usecases/releaseNaming.ts';

type Call = { method: string; path: string; query: URLSearchParams; body: any; headers: Record<string, string> };
type Handler = (call: Call) => unknown;

// Fetch falso: casa "MÉTODO /caminho" por sufixo do pathname e registra as chamadas.
function fake(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetchImpl = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const call: Call = {
      method: init.method ?? 'GET',
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string>,
    };
    calls.push(call);
    const key = Object.keys(routes).find((k) => {
      const [method, suffix] = k.split(' ');
      return method === call.method && call.path.endsWith(suffix!);
    });
    const result = key ? routes[key]!(call) : new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

const repository = { id: 'api', name: 'api', projectId: 'muralis' };
const github = (routes: Record<string, Handler>) => {
  const { fetchImpl, calls } = fake(routes);
  const sourceControl = new GitHubSourceControl(
    { owner: 'muralis', releasePattern: DEFAULT_RELEASE_PATTERN, developBranch: 'develop' },
    async () => 'ghp-token',
    fetchImpl,
    1,
  );
  return { sourceControl, calls };
};

describe('GitHub · pull requests', () => {
  const actor = (login: string, databaseId: number, name?: string) => ({ login, databaseId, name });
  const node = (overrides: object) => ({
    number: 12,
    title: 'feat: exportar relatório',
    url: 'https://github.com/muralis/api/pull/12',
    isDraft: false,
    createdAt: '2026-10-10T12:00:00Z',
    mergeable: 'MERGEABLE',
    baseRefName: 'develop',
    headRefName: 'feature/PROJ-7-exportar',
    totalCommentsCount: 4,
    reviewDecision: null,
    author: actor('manoel', 2, 'Manoel Martins'),
    repository: { name: 'api' },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    ...overrides,
  });

  it('extrai o PR da mensagem de merge e de squash, e ignora o resto', () => {
    expect(
      pullRequestIdsFromMessages([
        'Merge pull request #12 from muralis/feature\n\nfeat: x',
        'fix: arredondamento (#15)',
        'fix: arredondamento (#15)',
        'chore: menciona #99 no meio do texto',
        'docs: sem número',
        undefined,
      ]),
    ).toEqual([12, 15]);
  });

  it('junta votos e pedidos de revisão; pedir de novo zera o voto', () => {
    const reviews = toReviews({
      latestOpinionatedReviews: {
        nodes: [
          { state: 'APPROVED', author: actor('ana', 3, 'Ana') },
          { state: 'CHANGES_REQUESTED', author: actor('bruno', 4, 'Bruno') },
          { state: 'APPROVED', author: actor('pedro', 1, 'Pedro') },
        ],
      },
      reviewRequests: { nodes: [{ requestedReviewer: actor('pedro', 1, 'Pedro') }, { requestedReviewer: {} }, { requestedReviewer: null }] },
    });
    expect(reviews.map((r) => [r.reviewer.id, r.decision])).toEqual([
      ['3', 'approved'],
      ['4', 'waiting-author'],
      ['1', 'pending'],
    ]);
  });

  it('lista os PRs abertos da organização numa consulta só e os traduz para o modelo canônico', async () => {
    const { sourceControl, calls } = github({
      'POST /graphql': () => ({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              node({ reviewRequests: { nodes: [{ requestedReviewer: actor('pedro', 1, 'Pedro Carlo') }] } }),
              node({ number: 13, mergeable: 'CONFLICTING', author: null, totalCommentsCount: null }),
              node({
                number: 14,
                reviewDecision: 'APPROVED',
                latestOpinionatedReviews: { nodes: [{ state: 'APPROVED', author: actor('ana', 3, 'Ana') }] },
                reviewRequests: { nodes: [{ requestedReviewer: actor('pedro', 1, 'Pedro Carlo') }] },
              }),
              {},
            ],
          },
        },
      }),
    });
    const pulls = await sourceControl.listOpenPullRequests('muralis');
    const me = { id: '1', name: 'Pedro Carlo' };

    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.variables.q).toBe('is:pr is:open archived:false user:muralis');
    expect(calls[0]!.headers.Authorization).toBe('Bearer ghp-token');
    expect(pulls[0]).toMatchObject({
      provider: 'github',
      id: 12,
      repository: { id: 'api', name: 'api', projectId: 'muralis' },
      sourceBranch: 'feature/PROJ-7-exportar',
      targetBranch: 'develop',
      author: { id: '2', name: 'Manoel Martins', avatarKey: '2' },
      mergeState: 'clean',
      commentCount: 4,
      webUrl: 'https://github.com/muralis/api/pull/12',
    });
    expect(classify(pulls[0]!, me)).toEqual({ column: 'dependsOnMe', reason: 'reviewer' });
    // Autor apagado vira "ghost"; conflito sem contagem conta como um.
    expect(pulls[1]).toMatchObject({ author: { id: 'ghost' }, mergeState: 'conflicts', conflictCount: 1, commentCount: 0 });
    expect(classify(pulls[1]!, me).column).toBe('conflict');
    // O GitHub já considera aprovado: meu voto pendente não segura o PR.
    expect(classify(pulls[2]!, me).column).toBe('ready');
  });

  it('pagina a busca e para quando acaba', async () => {
    let page = 0;
    const { sourceControl, calls } = github({
      'POST /graphql': () => ({
        data: { search: { pageInfo: { hasNextPage: ++page < 3, endCursor: `c${page}` }, nodes: [node({ number: page })] } },
      }),
    });
    expect((await sourceControl.listOpenPullRequests('muralis')).map((p) => p.id)).toEqual([1, 2, 3]);
    expect(calls.map((c) => c.body.variables.cursor)).toEqual([null, 'c1', 'c2']);
  });

  it('token recusado e erro do GraphQL viram os erros do núcleo', async () => {
    const denied = github({ 'POST /graphql': () => new Response('{}', { status: 401 }) });
    await expect(denied.sourceControl.countOpenPullRequests('muralis')).rejects.toBeInstanceOf(NotAuthenticatedError);
    const broken = github({ 'POST /graphql': () => ({ errors: [{ message: 'Field x does not exist' }] }) });
    await expect(broken.sourceControl.countOpenPullRequests('muralis')).rejects.toThrow('Field x does not exist');
  });

  it('lista repositórios da organização e, se o dono for um usuário, os dele', async () => {
    const org = github({
      'GET /orgs/muralis/repos': () => [
        { name: 'api', owner: { login: 'muralis' } },
        { name: 'legado', archived: true, owner: { login: 'muralis' } },
      ],
    });
    expect(await org.sourceControl.listRepositories('muralis')).toEqual([{ id: 'api', name: 'api', projectId: 'muralis' }]);

    const user = github({
      'GET /user/repos': () => [
        { name: 'dotfiles', owner: { login: 'Pedro' } },
        { name: 'outra', owner: { login: 'alguem' } },
      ],
    });
    expect((await user.sourceControl.listRepositories('pedro')).map((r) => r.name)).toEqual(['dotfiles']);
  });

  it('mergeados: só os PRs fechados com merge, com a data do merge', async () => {
    const pull = (number: number, merged_at: string | null) => ({
      number,
      title: `pr ${number}`,
      html_url: `https://github.com/muralis/api/pull/${number}`,
      created_at: '2026-10-01T00:00:00Z',
      merged_at,
      merge_commit_sha: 'sha',
      user: { id: 2, login: 'manoel' },
      base: { ref: 'develop' },
      head: { ref: 'f' },
    });
    const { sourceControl, calls } = github({ 'GET /repos/muralis/api/pulls': () => [pull(20, '2026-10-09T10:00:00Z'), pull(21, null)] });
    const merged = await sourceControl.listMergedPullRequests(repository, 'develop');

    expect(merged.map((p) => [p.id, p.status, p.closedAt, p.author.name])).toEqual([[20, 'merged', '2026-10-09T10:00:00Z', 'manoel']]);
    expect(Object.fromEntries(calls[0]!.query)).toMatchObject({ state: 'closed', base: 'develop' });
  });

  it('branches de release pelo padrão, da mais nova para a mais antiga, e os PRs pela comparação', async () => {
    const { sourceControl, calls } = github({
      'GET /git/matching-refs/heads/release': () =>
        ['release/2.9', 'release/2.15', 'release/131046-descricao', 'release/2.15-hotfix'].map((name) => ({ ref: `refs/heads/${name}` })),
      'GET /compare/develop...release/2.15': () => ({ ahead_by: 0 }),
      'GET /compare/develop...release/2.9': () => ({ ahead_by: 4 }),
      'GET /compare/main...release/2.15': () => ({
        commits: [{ commit: { message: 'Merge pull request #12 from muralis/x' } }, { commit: { message: 'fix: y (#15)' } }],
      }),
    });
    const branches = await sourceControl.listReleaseBranches(repository);

    expect(branches.map((b) => [b.name, b.baseBranch, b.createdAt])).toEqual([
      ['release/2.15', 'develop', undefined],
      ['release/2.9', undefined, undefined],
    ]);
    expect(branches[0]!.webUrl).toBe('https://github.com/muralis/api/tree/release/2.15');
    expect(await sourceControl.listPullRequestIdsInBranch(repository, 'release/2.15', 'main')).toEqual([12, 15]);
    expect(await sourceControl.listPullRequestIdsInBranch(repository, 'release/2.15', 'nao-existe')).toEqual([]);
    expect(calls.some((c) => c.path.endsWith('/compare/main...release/2.15'))).toBe(true);
  });

  it('diz quais branches existem', async () => {
    const { sourceControl } = github({ 'GET /branches/master': () => ({ name: 'master' }) });
    expect(await sourceControl.existingBranches(repository, ['main', 'master'])).toEqual(['master']);
  });
});

describe('GitHub · criação da branch de release', () => {
  // Um repositório mínimo: commits com árvore e pais, refs, e o merge que soma árvores ou conflita.
  function gitFake(conflictOn?: number) {
    const commits = new Map<string, { tree: string; parents: string[]; message: string }>([
      ['main0', { tree: 't-main', parents: [], message: 'base' }],
      ['m12', { tree: 't-12', parents: ['d0', 'f12'], message: 'Merge pull request #12 from muralis/a\n\nfeat: a' }],
      ['s15', { tree: 't-15', parents: ['d1'], message: 'fix: b' }],
    ]);
    const refs = new Map<string, string>([['refs/heads/main', 'main0']]);
    let seq = 0;
    const routes: Record<string, Handler> = {
      'GET /git/ref/heads/main': () => ({ object: { sha: refs.get('refs/heads/main') } }),
      'GET /pulls/12': () => ({ number: 12, merge_commit_sha: 'm12' }),
      'GET /pulls/15': () => ({ number: 15, merge_commit_sha: 's15' }),
      'GET /user': () => ({ id: 1, login: 'pedro', name: 'Pedro Carlo' }),
      'POST /git/commits': ({ body }) => {
        const sha = `c${++seq}`;
        commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message });
        return { sha };
      },
      'POST /git/refs': ({ body }) => {
        refs.set(body.ref, body.sha);
        return { ref: body.ref };
      },
      'POST /merges': ({ body }) => {
        const pr = body.head === 'm12' ? 12 : 15;
        if (pr === conflictOn) return new Response(JSON.stringify({ message: 'Merge conflict' }), { status: 409 });
        const base = commits.get(refs.get(`refs/heads/${body.base}`)!)!;
        return new Response(JSON.stringify({ sha: `merge${pr}`, commit: { tree: { sha: `${base.tree}+${pr}` } } }), { status: 201 });
      },
    };
    const { fetchImpl, calls } = fake(routes);
    // Rotas com sha ou nome de ref no fim do caminho.
    const dynamic = async (input: string, init: RequestInit = {}) => {
      const path = decodeURIComponent(new URL(input).pathname);
      const method = init.method ?? 'GET';
      const commit = path.match(/\/git\/commits\/(\w+)$/);
      if (commit && method === 'GET') {
        const found = commits.get(commit[1]!)!;
        return Response.json({ sha: commit[1], message: found.message, parents: found.parents.map((sha) => ({ sha })), tree: { sha: found.tree } });
      }
      const ref = path.match(/\/git\/refs\/(heads\/.+)$/);
      if (ref && method === 'PATCH') {
        refs.set(`refs/${ref[1]}`, JSON.parse(String(init.body)).sha);
        calls.push({ method, path, query: new URLSearchParams(), body: JSON.parse(String(init.body)), headers: {} });
        return Response.json({});
      }
      if (ref && method === 'DELETE') {
        refs.delete(`refs/${ref[1]}`);
        calls.push({ method, path, query: new URLSearchParams(), body: undefined, headers: {} });
        return new Response(null, { status: 204 });
      }
      return fetchImpl(input, init);
    };
    const sourceControl = new GitHubSourceControl(
      { owner: 'muralis', releasePattern: DEFAULT_RELEASE_PATTERN, developBranch: 'develop' },
      async () => 't',
      dynamic,
      1,
    );
    return { sourceControl, commits, refs, calls };
  }

  const input = { repository, name: 'release/2.16', baseBranch: 'main', pullRequestIds: [12, 15] };

  it('aplica cada PR sobre a release, na ordem, e só então cria a branch', async () => {
    const { sourceControl, commits, refs } = gitFake();
    const branch = await sourceControl.createReleaseBranch(input);

    expect(branch).toMatchObject({ name: 'release/2.16', baseBranch: 'main', createdBy: { id: '1' } });
    // Só sobram main e a release: a branch temporária foi apagada.
    expect([...refs.keys()].sort()).toEqual(['refs/heads/main', 'refs/heads/release/2.16']);

    const second = commits.get(refs.get('refs/heads/release/2.16')!)!;
    const first = commits.get(second.parents[0]!)!;
    // Cada commit da release tem um pai só (o anterior) e a árvore acumulada.
    expect(first).toMatchObject({ tree: 't-main+12', parents: ['main0'] });
    expect(second).toMatchObject({ tree: 't-main+12+15', parents: [second.parents[0]] });
    // A mensagem leva o número do PR: a de merge já tinha, a de squash sem número ganha.
    expect(first.message.split('\n')[0]).toBe('Merge pull request #12 from muralis/a');
    expect(second.message).toBe('fix: b (#15)');
    expect(pullRequestIdsFromMessages([first.message, second.message])).toEqual([12, 15]);
  });

  it('o commit temporário usa a árvore da release e o pai do commit do PR', async () => {
    const { sourceControl, calls } = gitFake();
    await sourceControl.createReleaseBranch(input);
    const staging = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/git/commits')).map((c) => c.body).filter((b) => b.message.includes('preparar'));
    expect(staging.map((b) => [b.tree, b.parents])).toEqual([
      ['t-main', ['d0']],
      ['t-main+12', ['d1']],
    ]);
  });

  it('em conflito não cria a release e apaga a temporária', async () => {
    const { sourceControl, refs } = gitFake(15);
    const attempt = sourceControl.createReleaseBranch(input);
    await expect(attempt).rejects.toBeInstanceOf(CherryPickConflictError);
    await expect(attempt).rejects.toMatchObject({ pullRequestId: 15, baseBranch: 'main' });
    expect([...refs.keys()]).toEqual(['refs/heads/main']);
  });
});

describe('Jira', () => {
  const credentials = { site: 'muralis.atlassian.net', cloudId: 'cloud-1', email: 'pedro@muralis.com.br' };
  const jira = (routes: Record<string, Handler>) => {
    const { fetchImpl, calls } = fake(routes);
    return { tracking: new JiraWorkTracking(credentials, async () => 'api-token', fetchImpl, 1), calls };
  };
  const issue = (id: string, key: string, summary: string, type: object, status: object, parent?: object) => ({
    id,
    key,
    fields: { summary, issuetype: type, status, parent },
  });
  const story = { name: 'História', hierarchyLevel: 0 };
  const epic = { name: 'Epic', hierarchyLevel: 1 };
  const done = { name: 'Concluído', statusCategory: { key: 'done' } };
  const doing = { name: 'Em andamento', statusCategory: { key: 'indeterminate' } };
  const testing = { name: 'Em teste', statusCategory: { key: 'indeterminate' } };
  const ref = { projectId: 'muralis', repositoryId: 'api', pullRequestId: 12, title: 'PROJ-7: exportar relatório', sourceBranch: 'feature/proj-7-exportar', webUrl: 'https://github.com/muralis/api/pull/12' };

  it('só aceita sites do Jira Cloud e resolve o cloudId', async () => {
    expect(parseJiraSite('https://Muralis.atlassian.net/jira/software')).toBe('muralis.atlassian.net');
    for (const bad of ['evil.com', 'muralis.atlassian.net.evil.com', 'localhost', '', 42]) {
      expect(() => parseJiraSite(bad), String(bad)).toThrow(ValidationError);
    }
    const { fetchImpl } = fake({ 'GET /_edge/tenant_info': () => ({ cloudId: 'cloud-1' }) });
    expect(await resolveCloudId('muralis.atlassian.net', fetchImpl)).toBe('cloud-1');
    await expect(resolveCloudId('naoexiste.atlassian.net', fake({}).fetchImpl)).rejects.toThrow('Não encontrei um Jira');
  });

  it('acha chaves de issue no título e na branch', () => {
    expect(issueKeysFrom('PROJ-7: exportar', 'feature/proj-7-exportar', 'fix AB-12 e AB-13', undefined)).toEqual(['PROJ-7', 'AB-12', 'AB-13']);
    expect(issueKeysFrom('feat: sem chave, release/2.15 e #12')).toEqual([]);
    // Parecidos com chave (UTF-8) passam aqui; quem descarta é o Jira, por não existirem.
    expect(issueKeysFrom('ajuste de utf-8')).toEqual(['UTF-8']);
  });

  it('issues do PR: as vinculadas por aqui e as citadas no título, sem repetir, com o épico como pai', async () => {
    const proj7 = issue('1007', 'PROJ-7', 'Exportar relatório', story, testing, { id: '1001', key: 'PROJ-1', fields: { summary: 'Relatórios', issuetype: epic, status: doing } });
    const { tracking, calls } = jira({
      'POST /search/jql': () => ({ issues: [proj7, issue('1009', 'PROJ-9', 'Corrigir arredondamento', { name: 'Bug', hierarchyLevel: 0 }, done)] }),
      'GET /issue/PROJ-7': () => proj7,
    });
    const items = await tracking.listWorkItemsForPullRequest(ref);

    expect(calls[0]!.path).toBe('/ex/jira/cloud-1/rest/api/3/search/jql');
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from('pedro@muralis.com.br:api-token').toString('base64')}`);
    expect(calls.find((c) => c.method === 'POST')!.body.jql).toBe(`issue in issuesWithRemoteLinksByGlobalId("${remoteLinkGlobalId(ref)}")`);
    expect(items).toEqual([
      {
        id: 1007,
        key: 'PROJ-7',
        title: 'Exportar relatório',
        kind: 'task',
        state: { name: 'Em teste', category: 'testing' },
        webUrl: 'https://muralis.atlassian.net/browse/PROJ-7',
        parent: {
          id: 1001,
          key: 'PROJ-1',
          title: 'Relatórios',
          kind: 'pbi',
          state: { name: 'Em andamento', category: 'in-progress' },
          webUrl: 'https://muralis.atlassian.net/browse/PROJ-1',
        },
      },
      {
        id: 1009,
        key: 'PROJ-9',
        title: 'Corrigir arredondamento',
        kind: 'bug',
        state: { name: 'Concluído', category: 'done' },
        webUrl: 'https://muralis.atlassian.net/browse/PROJ-9',
        parent: undefined,
      },
    ]);
  });

  it('chave citada que não existe neste Jira é ignorada', async () => {
    const { tracking } = jira({ 'POST /search/jql': () => ({ issues: [] }) });
    expect(await tracking.listWorkItemsForPullRequest({ ...ref, title: 'UTF-8: ajuste' })).toEqual([]);
  });

  it('busca por texto como literal, e por chave direto na issue', async () => {
    const { tracking, calls } = jira({
      'POST /search/jql': () => ({ issues: [] }),
      'GET /issue/PROJ-7': () => issue('1007', 'PROJ-7', 'Exportar', story, doing),
    });
    await tracking.searchWorkItems('muralis', 'relatório "x" \\ y');
    expect(calls[0]!.body).toMatchObject({ jql: 'summary ~ "relatório  x    y*" AND hierarchyLevel <= 0 ORDER BY updated DESC', maxResults: 8 });
    expect((await tracking.searchWorkItems('muralis', 'proj-7')).map((w) => w.key)).toEqual(['PROJ-7']);
  });

  it('vincula como remote link para o PR e desfaz pelo mesmo identificador', async () => {
    const { tracking, calls } = jira({
      'POST /issue/1007/remotelink': () => ({ id: 1 }),
      'DELETE /issue/1007/remotelink': () => new Response(null, { status: 204 }),
    });
    await tracking.linkPullRequest(1007, ref);
    expect(calls[0]!.body).toEqual({
      globalId: 'release-management:pr:muralis/api#12',
      application: { type: 'release-management', name: 'Release Management' },
      relationship: 'pull request',
      object: { url: 'https://github.com/muralis/api/pull/12', title: 'PR #12: PROJ-7: exportar relatório' },
    });
    await tracking.unlinkPullRequest(1007, ref);
    expect(calls[1]!.query.get('globalId')).toBe('release-management:pr:muralis/api#12');
    await expect(tracking.linkPullRequest(1007, { ...ref, webUrl: undefined })).rejects.toBeInstanceOf(ValidationError);
  });

  it('sem Jira conectado, nada a listar e vincular pede a conexão', async () => {
    const none = new NoWorkTracking();
    expect(await none.listWorkItemsForPullRequest()).toEqual([]);
    await expect(none.linkPullRequest()).rejects.toThrow('Conecte o Jira');
  });
});
