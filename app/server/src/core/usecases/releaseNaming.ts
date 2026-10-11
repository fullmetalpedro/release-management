// "release/2.15" -> [2, 15]; nomes sem números ficam por último na ordenação.
export function versionOf(branch: string): number[] {
  const tail = branch.slice(branch.lastIndexOf('/') + 1);
  return (tail.match(/\d+/g) ?? []).map(Number);
}

export function compareVersionsDesc(a: string, b: string): number {
  const va = versionOf(a);
  const vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (vb[i] ?? -1) - (va[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return b.localeCompare(a);
}

// Aceita release-sprint-35, release/2.15 e release/0.1.0. O nome precisa terminar no número, o que deixa de fora
// branches de trabalho (release/131046-remover-ativo) e hotfixes (release-sprint-35-hotfix).
export const DEFAULT_RELEASE_PATTERN = String.raw`^release[-/](sprint-)?\d+(\.\d+)*$`;

// Trecho literal no começo do padrão, usado para pedir ao provedor só as branches candidatas.
export function literalPrefix(pattern: string): string {
  const match = /^\^?([\w/-]*)(.?)/.exec(pattern);
  const literal = match?.[1] ?? '';
  // Um quantificador logo depois torna opcional o último caractere, que então não é prefixo garantido.
  return /[?*{]/.test(match?.[2] ?? '') ? literal.slice(0, -1) : literal;
}

// Segue o formato da última release do repositório; sem nenhuma, começa em `first`.
export function nextReleaseName(latest: string | undefined, first: string): string {
  if (!latest) return first;
  const match = latest.match(/^(.*?)(\d+)(\D*)$/);
  if (!match) return `${latest}-2`;
  const [, head, last, tail] = match;
  return `${head}${Number(last) + 1}${tail}`;
}

// Regras do git para nomes de ref, o suficiente para barrar o que o provedor recusaria.
export function isValidBranchName(name: string): boolean {
  if (!name || name.length > 200) return false;
  if (/[\s~^:?*\[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$|\.lock$/.test(name)) return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.'));
}
