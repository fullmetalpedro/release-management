// Mensagens que chegam ao usuário. O navegador manda o idioma escolhido em Accept-Language; sem ele, português.
// Os termos seguem os que cada plataforma usa na própria interface (Azure DevOps em francês: "jeton d'accès
// personnel", "élément de travail"; Jira em inglês: "work item").

export type Locale = 'pt' | 'en' | 'fr';
export const LOCALES: Locale[] = ['pt', 'en', 'fr'];

type Params = Record<string, string | number>;

const CATALOG = {
  sessionExpired: {
    pt: 'Sessão expirada',
    en: 'Your session has expired',
    fr: 'Votre session a expiré',
  },
  sessionTokenRejected: {
    pt: 'O {provider} recusou o token da sessão',
    en: '{provider} rejected the token for this session',
    fr: '{provider} a refusé le jeton de cette session',
  },
  providerDown: {
    pt: '{provider} não respondeu',
    en: "{provider} isn't responding",
    fr: '{provider} ne répond pas',
  },
  providerDownDetail: {
    pt: '{provider} não respondeu: {detail}',
    en: "{provider} isn't responding: {detail}",
    fr: '{provider} ne répond pas : {detail}',
  },
  cherryPickConflict: {
    pt: 'Conflito ao aplicar #{id} sobre {base}',
    en: 'Conflict applying #{id} onto {base}',
    fr: "Conflit lors de l'application de #{id} sur {base}",
  },
  cherryPickFailed: {
    pt: 'Cherry-pick do PR #{id} falhou',
    en: 'Cherry-pick of PR #{id} failed',
    fr: 'Le cherry-pick du PR #{id} a échoué',
  },
  cherryPickResultMissing: {
    pt: 'Não foi possível localizar o resultado do cherry-pick',
    en: "Couldn't find the result of the cherry-pick",
    fr: 'Impossible de trouver le résultat du cherry-pick',
  },
  cherryPickTimeout: {
    pt: 'O Azure DevOps demorou demais para aplicar o cherry-pick',
    en: 'Azure DevOps took too long to apply the cherry-pick',
    fr: 'Azure DevOps a mis trop de temps à appliquer le cherry-pick',
  },
  refUpdateFailed: {
    pt: 'Não foi possível atualizar {branch}: {status}',
    en: "Couldn't update {branch}: {status}",
    fr: 'Impossible de mettre à jour {branch} : {status}',
  },
  refUpdateFailedUnknown: {
    pt: 'Não foi possível atualizar {branch}',
    en: "Couldn't update {branch}",
    fr: 'Impossible de mettre à jour {branch}',
  },
  linkGone: {
    pt: 'O vínculo não existe mais',
    en: 'This link no longer exists',
    fr: "Ce lien n'existe plus",
  },
  loginNoIdentity: {
    pt: 'O login não devolveu a identidade do usuário',
    en: "Sign-in didn't return the user's identity",
    fr: "La connexion n'a pas renvoyé l'identité de l'utilisateur",
  },
  microsoftUnavailable: {
    pt: 'Login da Microsoft indisponível: {detail}',
    en: 'Microsoft sign-in is unavailable: {detail}',
    fr: 'La connexion Microsoft est indisponible : {detail}',
  },
  microsoftRejected: {
    pt: 'A Microsoft recusou o login',
    en: 'Microsoft rejected the sign-in',
    fr: 'Microsoft a refusé la connexion',
  },
  microsoftStatus: {
    pt: 'A Microsoft respondeu {status}',
    en: 'Microsoft responded with {status}',
    fr: 'Microsoft a répondu {status}',
  },
  prNoMergeCommit: {
    pt: 'O PR #{id} não tem commit de merge',
    en: 'PR #{id} has no merge commit',
    fr: "Le PR #{id} n'a pas de commit de fusion",
  },
  prCommitNoParent: {
    pt: 'O commit do PR #{id} não tem pai',
    en: 'The commit of PR #{id} has no parent',
    fr: "Le commit du PR #{id} n'a pas de parent",
  },
  prApplyFailed: {
    pt: 'Não foi possível aplicar o PR #{id}',
    en: "Couldn't apply PR #{id}",
    fr: "Impossible d'appliquer le PR #{id}",
  },
  githubNoData: {
    pt: 'O GitHub não devolveu dados',
    en: "GitHub didn't return any data",
    fr: "GitHub n'a renvoyé aucune donnée",
  },
  atlassianEmailRequired: {
    pt: 'Informe o e-mail da sua conta Atlassian.',
    en: 'Enter the email address of your Atlassian account.',
    fr: "Saisissez l'adresse e-mail de votre compte Atlassian.",
  },
  tokenUnreadable: {
    pt: 'Não foi possível ler o token. Recarregue a página e tente de novo.',
    en: "Couldn't read the token. Reload the page and try again.",
    fr: 'Impossible de lire le jeton. Rechargez la page et réessayez.',
  },
  githubOwnerInvalid: {
    pt: 'Informe a organização ou o usuário, como em github.com/<organização>.',
    en: 'Enter the organization or user, as in github.com/<organization>.',
    fr: "Saisissez l'organisation ou l'utilisateur, comme dans github.com/<organisation>.",
  },
  organizationInvalid: {
    pt: 'Informe o nome da organização, como em dev.azure.com/<organização>.',
    en: 'Enter the organization name, as in dev.azure.com/<organization>.',
    fr: "Saisissez le nom de l'organisation, comme dans dev.azure.com/<organisation>.",
  },
  internalError: {
    pt: 'Erro interno',
    en: 'Something went wrong on our side',
    fr: 'Erreur interne',
  },
  tooManyRequests: {
    pt: 'Muitas tentativas em pouco tempo. Aguarde um instante e tente de novo.',
    en: 'Too many attempts in a short time. Wait a moment and try again.',
    fr: 'Trop de tentatives en peu de temps. Patientez un instant et réessayez.',
  },
  invalidId: {
    pt: 'Identificador inválido',
    en: 'Invalid identifier',
    fr: 'Identifiant non valide',
  },
  tooManyPullRequests: {
    pt: 'Selecione no máximo {max} PRs por release.',
    en: 'Select up to {max} pull requests per release.',
    fr: 'Sélectionnez au maximum {max} PR par release.',
  },
  invalidRequest: {
    pt: 'Requisição inválida',
    en: 'Invalid request',
    fr: 'Requête non valide',
  },
  providerStatus: {
    pt: '{provider} respondeu {status}',
    en: '{provider} responded with {status}',
    fr: '{provider} a répondu {status}',
  },
  unknownPlatform: {
    pt: 'Plataforma desconhecida',
    en: 'Unknown platform',
    fr: 'Plateforme inconnue',
  },
  tokenRequired: {
    pt: 'Informe o token.',
    en: 'Enter the token.',
    fr: 'Saisissez le jeton.',
  },
  tokenMalformed: {
    pt: 'Esse token não parece um token de acesso pessoal.',
    en: "This doesn't look like a personal access token.",
    fr: "Ceci ne ressemble pas à un jeton d'accès personnel.",
  },
  tokenRejected: {
    pt: 'O {provider} recusou o token. Confira se ele é dessa conta, se não expirou e se tem os escopos do guia.',
    en: '{provider} rejected the token. Check that it belongs to this account, hasn’t expired and has the scopes listed in the guide.',
    fr: "{provider} a refusé le jeton. Vérifiez qu'il appartient à ce compte, qu'il n'a pas expiré et qu'il dispose des étendues indiquées dans le guide.",
  },
  tokenNoAccess: {
    pt: 'O token não tem acesso a {account}.',
    en: "The token doesn't have access to {account}.",
    fr: "Le jeton n'a pas accès à {account}.",
  },
  platformNotConnected: {
    pt: 'Essa plataforma não está conectada.',
    en: "This platform isn't connected.",
    fr: "Cette plateforme n'est pas connectée.",
  },
  noPhoto: {
    pt: 'Sem foto',
    en: 'No photo',
    fr: 'Pas de photo',
  },
  routeNotFound: {
    pt: 'Rota não encontrada',
    en: 'Route not found',
    fr: 'Route introuvable',
  },
  branchAndPrsRequired: {
    pt: 'Informe o nome da branch e os PRs',
    en: 'Enter the branch name and the PRs',
    fr: 'Indiquez le nom de la branche et les PR',
  },
  jiraSiteInvalid: {
    pt: 'Informe o site do Jira, como em suaempresa.atlassian.net.',
    en: 'Enter your Jira site, as in yourcompany.atlassian.net.',
    fr: 'Saisissez votre site Jira, comme dans votreentreprise.atlassian.net.',
  },
  jiraNotFound: {
    pt: 'Não encontrei um Jira em {site}.',
    en: "Couldn't find a Jira site at {site}.",
    fr: 'Aucun site Jira trouvé à {site}.',
  },
  prNoUrl: {
    pt: 'O PR não tem endereço para vincular.',
    en: "The PR doesn't have a URL to link to.",
    fr: "Le PR n'a pas d'adresse à lier.",
  },
  connectJira: {
    pt: 'Conecte o Jira para vincular issues aos PRs do GitHub.',
    en: 'Connect Jira to link work items to GitHub pull requests.',
    fr: 'Connectez Jira pour lier des tickets aux pull requests GitHub.',
  },
  workItemNotFound: {
    pt: 'Work item {id} não encontrado',
    en: 'Work item {id} not found',
    fr: 'Élément de travail {id} introuvable',
  },
  branchNotFound: {
    pt: 'A branch {branch} não existe',
    en: "Branch {branch} doesn't exist",
    fr: "La branche {branch} n'existe pas",
  },
  repositoryNotFound: {
    pt: 'Repositório não encontrado',
    en: 'Repository not found',
    fr: 'Référentiel introuvable',
  },
  invalidBranchName: {
    pt: 'Nome de branch inválido',
    en: 'Invalid branch name',
    fr: 'Nom de branche non valide',
  },
  selectAtLeastOnePr: {
    pt: 'Selecione ao menos um PR',
    en: 'Select at least one PR',
    fr: 'Sélectionnez au moins un PR',
  },
  branchOutsidePattern: {
    pt: 'O nome {branch} não segue o padrão das releases deste servidor, então a branch não apareceria como release.',
    en: "The name {branch} doesn't match this server's release pattern, so the branch wouldn't show up as a release.",
    fr: "Le nom {branch} ne suit pas le modèle des releases de ce serveur ; la branche n'apparaîtrait pas comme release.",
  },
  branchExists: {
    pt: 'A branch {branch} já existe',
    en: 'Branch {branch} already exists',
    fr: 'La branche {branch} existe déjà',
  },
  onlyMergedPrs: {
    pt: 'Só PRs mergeados podem entrar na release',
    en: 'Only merged PRs can go into a release',
    fr: 'Seuls les PR fusionnés peuvent entrer dans une release',
  },
  invalidWorkItem: {
    pt: 'Work item inválido',
    en: 'Invalid work item',
    fr: 'Élément de travail non valide',
  },
  invalidPr: {
    pt: 'PR inválido',
    en: 'Invalid PR',
    fr: 'PR non valide',
  },
  projectRepositoryRequired: {
    pt: 'Projeto e repositório são obrigatórios',
    en: 'Project and repository are required',
    fr: 'Le projet et le référentiel sont obligatoires',
  },
  prNotFound: {
    pt: 'PR #{id} não encontrado',
    en: 'PR #{id} not found',
    fr: 'PR #{id} introuvable',
  },
  connectSource: {
    pt: 'Conecte o Azure DevOps ou o GitHub para ver os PRs.',
    en: 'Connect Azure DevOps or GitHub to see pull requests.',
    fr: 'Connectez Azure DevOps ou GitHub pour voir les pull requests.',
  },
} satisfies Record<string, Record<Locale, string>>;

export type MessageKey = keyof typeof CATALOG;

export interface Localized {
  key: MessageKey;
  params?: Params;
}

export const msg = (key: MessageKey, params?: Params): Localized => ({ key, params });

export function render(message: Localized, locale: Locale = 'pt'): string {
  return CATALOG[message.key][locale].replace(/\{(\w+)\}/g, (match, name: string) =>
    message.params && name in message.params ? String(message.params[name]) : match,
  );
}

// "fr-FR,fr;q=0.9,en;q=0.8" → fr. O primeiro idioma suportado vence; nenhum, português.
export function localeFrom(header: string | undefined): Locale {
  // "fr;q=0.8, en" pede inglês primeiro: a ordem é a do peso (q), e q=0 significa "não quero".
  const preferences = (header ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find(Boolean);
      return { base: tag.trim().toLowerCase().split('-')[0], weight: q === undefined ? 1 : Number(q) };
    })
    .filter((preference) => preference.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  for (const { base } of preferences) {
    const found = LOCALES.find((locale) => locale === base);
    if (found) return found;
  }
  return 'pt';
}
