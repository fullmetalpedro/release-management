import { NotFoundError } from '../../core/domain/errors.ts';
import type {
  PullRequestRef,
  WorkItem,
  WorkItemKind,
  WorkItemStateCategory,
  WorkItemSummary,
} from '../../core/domain/types.ts';
import type { WorkTracking } from '../../core/ports/workTracking.ts';
import { AzureDevOpsHttpError, type AzureDevOpsClient } from './client.ts';

interface AdoWorkItem {
  id: number;
  fields: {
    'System.Title': string;
    'System.WorkItemType': string;
    'System.State': string;
    'System.TeamProject': string;
    'System.Parent'?: number;
  };
  relations?: { rel: string; url: string }[];
}

const FIELDS = ['System.Title', 'System.WorkItemType', 'System.State', 'System.TeamProject', 'System.Parent'];
const SEARCH_LIMIT = 8;

export function toKind(typeName: string): WorkItemKind {
  if (/task|tarefa/i.test(typeName)) return 'task';
  if (/bug|defeito/i.test(typeName)) return 'bug';
  if (/backlog|story|hist[oó]ria|requirement|issue|feature|epic/i.test(typeName)) return 'pbi';
  return 'other';
}

// Os estados são do processo de cada projeto; o nome decide "em teste" e a categoria do Azure DevOps decide o resto.
export function toStateCategory(stateName: string, adoCategory: string | undefined): WorkItemStateCategory {
  if (/test|homolog|\bqa\b|valida/i.test(stateName)) return 'testing';
  switch (adoCategory) {
    case 'Completed':
      return 'done';
    case 'Resolved':
      return 'testing';
    case 'InProgress':
      return 'in-progress';
    case 'Removed':
      return 'removed';
    case 'Proposed':
      return 'todo';
  }
  if (/conclu|done|closed|fechad|resolvid/i.test(stateName)) return 'done';
  if (/andamento|progress|doing|active|commit/i.test(stateName)) return 'in-progress';
  return 'todo';
}

export function pullRequestArtifactUrl(ref: PullRequestRef): string {
  return `vstfs:///Git/PullRequestId/${ref.projectId}%2F${ref.repositoryId}%2F${ref.pullRequestId}`;
}

export class AzureDevOpsWorkTracking implements WorkTracking {
  private readonly stateCategories = new Map<string, Promise<Map<string, string>>>();

  constructor(private readonly client: AzureDevOpsClient) {}

  async listWorkItemsForPullRequest(ref: PullRequestRef): Promise<WorkItem[]> {
    const { value } = await this.client.get<{ value: { id: string }[] }>(
      `/${ref.projectId}/_apis/git/repositories/${ref.repositoryId}/pullRequests/${ref.pullRequestId}/workitems`,
    );
    return this.load(value.map((item) => Number(item.id)));
  }

  async searchWorkItems(projectId: string, term: string): Promise<WorkItem[]> {
    const match = /^\d+$/.test(term)
      ? `[System.Id] = ${Number(term)}`
      : `[System.Title] CONTAINS '${term.replaceAll("'", "''")}'`;
    const { workItems } = await this.client.post<{ workItems: { id: number }[] }>(`/${projectId}/_apis/wit/wiql`, {
      query: { $top: SEARCH_LIMIT },
      readOnly: true,
      body: {
        query:
          `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ` +
          `AND [System.WorkItemType] IN ('Task', 'Bug') AND ${match} ORDER BY [System.ChangedDate] DESC`,
      },
    });
    const ids = workItems.map((item) => item.id);
    const loaded = await this.load(ids);
    return ids.flatMap((id) => loaded.filter((item) => item.id === id));
  }

  async linkPullRequest(workItemId: number, ref: PullRequestRef): Promise<void> {
    await this.client.patch(`/_apis/wit/workitems/${workItemId}`, {
      contentType: 'application/json-patch+json',
      body: [
        {
          op: 'add',
          path: '/relations/-',
          value: { rel: 'ArtifactLink', url: pullRequestArtifactUrl(ref), attributes: { name: 'Pull Request' } },
        },
      ],
    });
  }

  async unlinkPullRequest(workItemId: number, ref: PullRequestRef): Promise<void> {
    const item = await this.client.get<AdoWorkItem>(`/_apis/wit/workitems/${workItemId}`, {
      query: { $expand: 'relations' },
    });
    const target = pullRequestArtifactUrl(ref).toLowerCase();
    const index = (item.relations ?? []).findIndex(
      (relation) => relation.rel === 'ArtifactLink' && relation.url.toLowerCase() === target,
    );
    if (index < 0) throw new NotFoundError('O vínculo não existe mais');
    await this.client.patch(`/_apis/wit/workitems/${workItemId}`, {
      contentType: 'application/json-patch+json',
      body: [{ op: 'remove', path: `/relations/${index}` }],
    });
  }

  private async load(ids: number[]): Promise<WorkItem[]> {
    const items = await this.batch(ids);
    const parentIds = [...new Set(items.flatMap((item) => item.fields['System.Parent'] ?? []))];
    const parents = new Map((await this.batch(parentIds)).map((item) => [item.id, item]));
    return Promise.all(
      items.map(async (item) => {
        const parent = parents.get(item.fields['System.Parent'] ?? -1);
        return { ...(await this.toSummary(item)), parent: parent && (await this.toSummary(parent)) };
      }),
    );
  }

  private async batch(ids: number[]): Promise<AdoWorkItem[]> {
    if (ids.length === 0) return [];
    const { value } = await this.client.post<{ value: AdoWorkItem[] }>('/_apis/wit/workitemsbatch', {
      readOnly: true,
      body: { ids: ids.slice(0, 200), fields: FIELDS, errorPolicy: 'Omit' },
    });
    return value.filter(Boolean);
  }

  private async toSummary(item: AdoWorkItem): Promise<WorkItemSummary> {
    const type = item.fields['System.WorkItemType'];
    const state = item.fields['System.State'];
    const categories = await this.categoriesFor(item.fields['System.TeamProject'], type);
    return {
      id: item.id,
      title: item.fields['System.Title'],
      kind: toKind(type),
      state: { name: state, category: toStateCategory(state, categories.get(state)) },
      webUrl: `${this.client.baseUrl}/_workitems/edit/${item.id}`,
    };
  }

  private categoriesFor(project: string, type: string): Promise<Map<string, string>> {
    const key = `${project}|${type}`;
    let cached = this.stateCategories.get(key);
    if (!cached) {
      cached = this.client
        .get<{ value: { name: string; category: string }[] }>(
          `/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`,
        )
        .then(({ value }) => new Map(value.map((s) => [s.name, s.category])))
        .catch((error) => {
          if (error instanceof AzureDevOpsHttpError) return new Map<string, string>();
          throw error;
        });
      this.stateCategories.set(key, cached);
    }
    return cached;
  }
}
