import { mapLimit } from '../concurrency.ts';
import type { SourceControl } from '../ports/sourceControl.ts';

export interface ProjectView {
  id: string;
  name: string;
  openPullRequests: number;
}

// `allowed` restringe e ordena os projetos pelo nome; vazio mostra todos os que o usuário enxerga.
export async function listProjects(
  deps: { sourceControl: SourceControl },
  allowed: string[] = [],
): Promise<ProjectView[]> {
  const all = await deps.sourceControl.listProjects();
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const matched = allowed.flatMap((name) => all.filter((p) => normalize(p.name) === normalize(name)));
  // Numa organização em que nenhum nome configurado existe, mostrar tudo é melhor que um seletor vazio.
  const selected = matched.length > 0 ? matched : [...all].sort((a, b) => a.name.localeCompare(b.name));

  return mapLimit(selected, 4, async (project) => ({
    id: project.id,
    name: project.name,
    openPullRequests: await deps.sourceControl.countOpenPullRequests(project.id),
  }));
}
