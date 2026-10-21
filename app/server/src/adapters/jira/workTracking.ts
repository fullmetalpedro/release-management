import { NotFoundError, ProviderUnavailableError, ValidationError } from '../../core/domain/errors.ts';
import type {
  Person,
  PullRequestRef,
  WorkItem,
  WorkItemKind,
  WorkItemStateCategory,
  WorkItemSummary,
} from '../../core/domain/types.ts';
import type { WorkTracking } from '../../core/ports/workTracking.ts';
import { isHttpStatus, JsonClient, type FetchLike } from '../http-json.ts';
import { msg } from '../../i18n.ts';
import { writeAllowed } from '../writeProbe.ts';

interface JiraIssueFields {
  summary: string;
  issuetype: { name: string; subtask?: boolean; hierarchyLevel?: number };
  status: { name: string; statusCategory?: { key?: string } };
  parent?: { id: string; key: string; fields?: Omit<JiraIssueFields, 'parent'> };
}

interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
}

const FIELDS = ['summary', 'issuetype', 'status', 'parent'];
const SEARCH_LIMIT = 8;
const ISSUE_KEY = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
const SITE = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/i;

export function parseJiraSite(value: unknown): string {
  const site = typeof value === 'string' ? value.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase() : '';
  // O endereço vira parte de uma URL chamada pelo servidor: só sites do Jira Cloud.
  if (!SITE.test(site)) throw new ValidationError(msg('jiraSiteInvalid'));
  return site;
}

export function toKind(type: JiraIssueFields['issuetype']): WorkItemKind {
  if (/bug|defeito|erro/i.test(type.name)) return 'bug';
  // Épicos (e o que estiver acima deles) agrupam; histórias, tarefas e subtarefas são o trabalho em si.
  if ((type.hierarchyLevel ?? 0) >= 1) return 'pbi';
  return 'task';
}

export function toStateCategory(status: JiraIssueFields['status']): WorkItemStateCategory {
  const key = status.statusCategory?.key;
  if (key === 'done') return 'done';
  if (key === 'new') return 'todo';
  return /test|homolog|\bqa\b|valida|review|revis/i.test(status.name) ? 'testing' : 'in-progress';
}

// Chaves de issue citadas no título ou na branch do PR ("PROJ-123: …", "feature/PROJ-123-…").
export function issueKeysFrom(...texts: (string | undefined)[]): string[] {
  return [...new Set(texts.flatMap((text) => text?.toUpperCase().match(ISSUE_KEY) ?? []))];
}

export function remoteLinkGlobalId(ref: PullRequestRef): string {
  return `release-management:pr:${ref.projectId}/${ref.repositoryId}#${ref.pullRequestId}`;
}

export interface JiraCredentials {
  site: string;
  cloudId: string;
  email: string;
}

const CLOUD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// O cloudId identifica o site na API da Atlassian; é público e resolvido uma vez, ao conectar.
export async function resolveCloudId(site: string, fetchImpl: FetchLike = fetch): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`https://${site}/_edge/tenant_info`, { signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw new ProviderUnavailableError('jira', msg('providerDownDetail', { provider: 'Jira', detail: (error as Error).message }));
  }
  const info = response.ok ? ((await response.json().catch(() => ({}))) as { cloudId?: string }) : {};
  // O cloudId entra no endereço da API, então só serve se tiver forma de UUID.
  if (typeof info.cloudId !== 'string' || !CLOUD_ID.test(info.cloudId)) throw new ValidationError(msg('jiraNotFound', { site }));
  return info.cloudId;
}

export class JiraWorkTracking implements WorkTracking {
  private readonly client: JsonClient;

  constructor(
    private readonly credentials: JiraCredentials,
    getToken: () => Promise<string>,
    fetchImpl?: FetchLike,
    retryDelayMs?: number,
  ) {
    this.client = new JsonClient({
      provider: 'jira',
      label: 'Jira',
      // Tokens com escopo só funcionam por este endereço, e os clássicos também passam por ele.
      baseUrl: `https://api.atlassian.com/ex/jira/${credentials.cloudId}/rest/api/3`,
      fetchImpl,
      retryDelayMs,
      headers: async () => ({
        Authorization: `Basic ${Buffer.from(`${credentials.email}:${await getToken()}`).toString('base64')}`,
      }),
    });
  }

  async currentUser(): Promise<Person> {
    const me = await this.client.get<{ accountId: string; displayName: string; emailAddress?: string }>('/myself');
    return { id: me.accountId, name: me.displayName, email: me.emailAddress ?? this.credentials.email };
  }

  // Uma issue pertence ao PR se foi vinculada por aqui (remote link) ou se a chave dela está no título ou na branch.
  async listWorkItemsForPullRequest(ref: PullRequestRef): Promise<WorkItem[]> {
    const keys = issueKeysFrom(ref.title, ref.sourceBranch);
    const [linked, mentioned] = await Promise.all([
      this.search(`issue in issuesWithRemoteLinksByGlobalId("${remoteLinkGlobalId(ref)}")`, 20),
      Promise.all(keys.map((key) => this.issue(key))),
    ]);
    const issues = new Map<string, JiraIssue>();
    for (const issue of [...linked, ...mentioned]) if (issue) issues.set(issue.id, issue);
    return [...issues.values()].map((issue) => this.toWorkItem(issue));
  }

  async searchWorkItems(_projectId: string, term: string): Promise<WorkItem[]> {
    const text = term.trim();
    const [key] = issueKeysFrom(text);
    if (key && key.length === text.length) {
      const issue = await this.issue(key);
      return issue ? [this.toWorkItem(issue)] : [];
    }
    // Aspas, barras, parênteses e afins têm significado no JQL e na busca de texto do Jira; do que o usuário
    // digitou só seguem letras, números, espaços, hífen e sublinhado.
    const literal = text.replace(/[^\p{L}\p{N}\s_-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!literal) return [];
    const issues = await this.search(`summary ~ "${literal}*" AND hierarchyLevel <= 0 ORDER BY updated DESC`, SEARCH_LIMIT);
    return issues.map((issue) => this.toWorkItem(issue));
  }

  // O token pode vincular PRs? Pede um link numa issue que não existe: com permissão, o Jira responde que a issue
  // não existe; sem, recusa o pedido.
  async probeWriteAccess(): Promise<boolean | undefined> {
    return writeAllowed(() =>
      this.client.json('/issue/RMPROBE-0/remotelink', {
        method: 'POST',
        body: { object: { url: 'https://release-management.invalid/probe', title: 'probe' } },
      }),
    );
  }

  async linkPullRequest(workItemId: number, ref: PullRequestRef): Promise<void> {
    if (!ref.webUrl) throw new ValidationError(msg('prNoUrl'));
    await this.client.json(`/issue/${workItemId}/remotelink`, {
      method: 'POST',
      body: {
        globalId: remoteLinkGlobalId(ref),
        application: { type: 'release-management', name: 'Release Management' },
        relationship: 'pull request',
        object: { url: ref.webUrl, title: `PR #${ref.pullRequestId}${ref.title ? `: ${ref.title}` : ''}` },
      },
    });
  }

  async unlinkPullRequest(workItemId: number, ref: PullRequestRef): Promise<void> {
    try {
      await this.client.json(`/issue/${workItemId}/remotelink`, {
        method: 'DELETE',
        query: { globalId: remoteLinkGlobalId(ref) },
      });
    } catch (error) {
      if (isHttpStatus(error, 404)) throw new NotFoundError(msg('linkGone'));
      throw error;
    }
  }

  private async issue(key: string): Promise<JiraIssue | undefined> {
    try {
      return await this.client.get<JiraIssue>(`/issue/${key}`, { fields: FIELDS.join(',') });
    } catch (error) {
      // Uma chave no título do PR pode não ser uma issue deste Jira.
      if (isHttpStatus(error, 404, 403)) return undefined;
      throw error;
    }
  }

  private async search(jql: string, maxResults: number): Promise<JiraIssue[]> {
    const result = await this.client.json<{ issues?: JiraIssue[] }>('/search/jql', {
      method: 'POST',
      readOnly: true,
      body: { jql, maxResults, fields: FIELDS },
    });
    return result.issues ?? [];
  }

  private toSummary(issue: { id: string; key: string; fields: Omit<JiraIssueFields, 'parent'> }): WorkItemSummary {
    return {
      id: Number(issue.id),
      key: issue.key,
      title: issue.fields.summary,
      kind: toKind(issue.fields.issuetype),
      state: { name: issue.fields.status.name, category: toStateCategory(issue.fields.status) },
      webUrl: `https://${this.credentials.site}/browse/${issue.key}`,
    };
  }

  private toWorkItem(issue: JiraIssue): WorkItem {
    const parent = issue.fields.parent;
    return {
      ...this.toSummary(issue),
      // O pai vem resumido dentro da issue; sem os campos dele, não há como montar o grupo.
      parent: parent?.fields ? this.toSummary({ id: parent.id, key: parent.key, fields: parent.fields }) : undefined,
    };
  }
}

// Sem ferramenta de tarefas conectada (GitHub sem Jira): nada a listar, e vincular pede a conexão.
export class NoWorkTracking implements WorkTracking {
  async listWorkItemsForPullRequest(): Promise<WorkItem[]> {
    return [];
  }

  async searchWorkItems(): Promise<WorkItem[]> {
    return [];
  }

  async linkPullRequest(): Promise<void> {
    throw new ValidationError(msg('connectJira'));
  }

  async unlinkPullRequest(): Promise<void> {
    throw new ValidationError(msg('connectJira'));
  }
}
