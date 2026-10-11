# Release Management — aplicação

Code review e releases de GetNota, LeadComex e Jane, seguindo o design em `../design/releaseManagement.pen`.
Os PRs vêm do Azure DevOps ou do GitHub, e as tasks, do Azure DevOps ou do Jira. A entrada é por conta Microsoft (só Azure DevOps) ou por token pessoal de cada plataforma.

## Rodar

```bash
npm install
npm run dev
```

Abra http://localhost:5173. Sem `.env`, a entrada é por token pessoal, informado na própria tela.

| Comando | O que faz |
|---|---|
| `npm run dev` | API (porta 3001) e front (porta 5173) com recarga |
| `npm test` | Testes do servidor |
| `npm run typecheck` | Tipos do servidor e do front |
| `npm run build` e `npm start` | Build do front e API servindo tudo na porta 3001 |

Para conferir o adapter contra a organização real sem gravar nada, com `AZDO_ORG` e `AZDO_PAT` no `.env`: `cd server && npx tsx --env-file=../.env scripts/smoke-readonly.ts`.

## Conectar ao Azure DevOps

1. No Microsoft Entra ID, crie um **App registration** (single tenant, o mesmo tenant ligado à organização do Azure DevOps).
2. Em **Authentication**, adicione a plataforma **Web** com a Redirect URI `http://localhost:5173/auth/microsoft/callback` (em produção, `https://<seu-domínio>/auth/microsoft/callback`).
3. Em **Certificates & secrets**, crie um client secret.
4. Em **API permissions**, adicione a permissão delegada **Azure DevOps → user_impersonation** e conceda o consentimento do administrador, se o tenant exigir.
5. Copie `.env.example` para `.env` e preencha `ENTRA_*`, `AZDO_ORG`, `AZDO_PROJECTS` e `SESSION_SECRET`.

O usuário só enxerga e altera o que as permissões dele no Azure DevOps permitem. Criar a branch de release exige permissão de criar branch no repositório; vincular task exige edição de work items.

Em produção, defina `APP_URL` com a URL pública (HTTPS) e, atrás de um proxy, `API_HOST=0.0.0.0`.

## Duas formas de entrar

A tela de entrada tem um seletor entre **Conta Microsoft** e **Token pessoal**, e a última escolha fica guardada no navegador.

- **Token pessoal:** sempre disponível. Cada plataforma tem o seu token, e o guia de escopos fica na própria tela. Conectar outro token numa plataforma substitui o dela, e é assim que se troca de organização.
  - **Azure DevOps:** organização e Personal Access Token. Fornece os PRs e os work items.
  - **GitHub:** organização (ou usuário) e fine-grained token. Fornece os PRs.
  - **Jira:** site (`empresa.atlassian.net`), e-mail da conta e API token. Fornece as tasks dos PRs do GitHub.
- **Conta Microsoft:** disponível quando o app registration está configurado (seção acima). Sem ele, a opção aparece com o aviso de que ainda não está configurada.

O token pessoal nunca fica em claro fora da memória do processo no instante do uso:

- **No envio:** o navegador cifra com RSA-OAEP usando uma chave pública que o servidor gera a cada inicialização.
- **No servidor:** é validado na plataforma e guardado selado com AES-256-GCM, tanto na sessão em memória quanto no arquivo `.data/sessions.enc`.
- **No navegador:** só existe o cookie de sessão (HttpOnly), que não contém o token.

As conexões se somam na mesma sessão. Para abrir o board é preciso o Azure DevOps ou o GitHub; com os dois conectados, o menu de contas escolhe de qual vêm os PRs. Com o GitHub ativo e sem Jira, o board e as releases funcionam, mas não há tasks para vincular.

Sem `SESSION_SECRET` as sessões não são gravadas em disco e caem a cada restart. Em produção use HTTPS de qualquer forma: a cifra do envio protege o token, não o cookie de sessão.

Para ver a interface com dados fictícios, sem provedor nenhum, suba com `AUTH_MODE=demo`.

## Como a release é montada

- **Mergeados**: PRs concluídos em `develop` cujo "Merged PR N" ainda não aparece na base (`main` ou `master`, a que existir no repositório) nem nas três últimas branches de release.
- **Quais branches são release**: `RELEASE_PATTERN` é uma regex. O padrão aceita `release-sprint-35`, `release/2.15` e `release/0.1.0`, e exige que o nome termine no número, o que deixa de fora branches de trabalho (`release/131046-descricao`) e hotfixes (`release-sprint-35-hotfix`). A mais nova é a de maior número, e o próximo nome sugerido segue o formato dela; num repositório sem release, vale `RELEASE_FIRST`.
- **Criar branch de release**: cada PR selecionado é aplicado por cherry-pick, em ordem de merge, sobre uma branch temporária a partir de `main`. Só quando todos passam a `release/x.y` é criada; em conflito, as temporárias são apagadas e nada fica para trás.
- **Release**: os PRs são lidos das mensagens de commit que a branch tem a mais que `main` (ou que a release anterior, se ela já voltou para `main`).

### No GitHub e no Jira

- **Projeto**: a organização (ou o usuário) informada na conexão é o único projeto; os repositórios são os dela.
- **Qual PR está em qual branch**: pelo número na primeira linha do commit, `Merge pull request #N` ou o `(#N)` do squash. Merge por rebase não deixa número e o PR não é reconhecido.
- **Criar branch de release**: a API do GitHub não tem cherry-pick. Cada PR é aplicado com um merge de três vias numa branch temporária `rm-tmp/…` (a base do merge é o pai do commit do PR), e o resultado vira um commit de pai único na release. A temporária é apagada no fim, com ou sem conflito.
- **Tasks de um PR**: as issues vinculadas por aqui (um *remote link* na issue, apontando para o PR) mais as chaves citadas no título ou na branch do PR (`PROJ-7`). O épico da issue faz o papel do PBI.

## Arquitetura

Hexagonal: o núcleo define portas por capacidade e não conhece nenhum provedor.

```
server/src
  core/domain      modelo canônico (PullRequest, Review, WorkItem, ReleaseBranch) e erros
  core/ports       SourceControl, WorkTracking, IdentityProvider
  core/usecases    board, projetos, mergeados/release, detalhe da release, vínculo de task
  adapters/azure-devops   SourceControl e WorkTracking sobre a REST API
  adapters/github         SourceControl sobre GraphQL (PRs abertos) e REST
  adapters/jira           WorkTracking sobre a REST API do Jira Cloud
  adapters/entra          IdentityProvider (authorization code + PKCE)
  adapters/memory         os mesmos contratos em memória (demonstração e testes)
  adapters/session        sessões cifradas em disco
  adapters/http           rotas Fastify
  registry.ts      escolhe os adapters de cada sessão
web/src            React + Tailwind
```

Para adicionar outra plataforma: implemente a porta correspondente em `adapters/`, registre em `registry.ts` e, para a conexão por token, em `adapters/http/patProviders.ts`. GitHub e Jira só entram por token pessoal; o login OAuth deles ainda não existe.
