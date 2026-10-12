# Release Management

Board de code review e montagem de releases para times que trabalham com vários repositórios, pensado para um momento em que a IA gera código mais rápido do que as pessoas conseguem revisar. Reúne num só lugar os pull requests que dependem de você, o que já foi mergeado e ainda não entrou em release, e o conteúdo de cada release com as tasks de cada PR.

Os PRs vêm do **Azure DevOps** ou do **GitHub**; as tasks, do **Azure DevOps** ou do **Jira**. A ferramenta não guarda dados dessas plataformas: lê e escreve nelas com a conta de quem está usando, e cada pessoa só enxerga e altera o que as próprias permissões permitem.

![Board de code review](docs/images/board.png)

## Sumário

- [Para que serve](#para-que-serve)
- [Como funciona na prática](#como-funciona-na-prática)
- [Formas de entrar](#formas-de-entrar)
- [Como o token pessoal trafega](#como-o-token-pessoal-trafega)
- [Arquitetura](#arquitetura)

## Para que serve

### O gargalo mudou de lugar

Com assistentes de IA, escrever código ficou rápido. O volume de pull requests cresceu, mas a capacidade de revisar continua sendo a das mesmas pessoas. O gargalo da entrega deixou de ser a escrita e passou a ser o **code review** e a organização em volta dele: saber o que está esperando por quem, o que já pode ser mergeado e o que de fato vai entrar na próxima release.

As plataformas mostram os PRs repositório por repositório, o que funciona com poucos PRs por dia e deixa de funcionar quando eles se multiplicam. Esta ferramenta existe para dar a quem revisa uma fila única e priorizada, e para tirar do caminho o trabalho manual de montar a release depois que a revisão termina.

### As perguntas do dia a dia

Num produto com vários repositórios, três perguntas tomam tempo todos os dias:

| Pergunta | Onde a ferramenta responde |
|---|---|
| Que PRs estão esperando por mim? | Coluna **Depende de mim**: PRs em que você é revisor e ainda não votou, e PRs seus em que um revisor pediu mudança. |
| O que já foi mergeado e ainda não saiu em release? | Coluna **Mergeados**: PRs concluídos em `develop` que não estão na base nem nas últimas releases. |
| O que tem dentro desta release? | Coluna **Release** e a tela cheia: PRs da release agrupados por PBI e task, com o estado de cada uma. |

A partir daí ela também faz duas coisas que hoje são manuais:

- **Cria a branch de release** a partir dos PRs escolhidos, com cherry-pick de cada um. Em conflito, nada fica criado pela metade.
- **Vincula a task ao PR** que entrou na release sem vínculo, direto na plataforma de origem.

## Como funciona na prática

### Board

Os PRs abertos do projeto são distribuídos em quatro colunas (Depende de mim, Em revisão, Conflito, Pronto pra merge), ao lado das colunas Mergeados e Release. Os filtros de autor, repositório e destino, a busca e a escolha de colunas visíveis ficam no topo.

Cada repositório pode ganhar uma cor, que vira a borda dos cards dele. Assim dá para reconhecer de longe de onde é cada PR.

![Seletor de cor por repositório](docs/images/cores-repositorio.png)

### Criar uma release

Na coluna **Mergeados**, marque os PRs e confirme o nome da branch (a sugestão segue o padrão da última release do repositório). A ferramenta aplica os PRs por cherry-pick, na ordem em que foram mergeados, e só cria a branch quando todos passam.

<img src="docs/images/criar-release.png" alt="Seleção de PRs e criação da branch de release" width="520">

### Release em tela cheia

A release mais recente de cada repositório abre numa tabela com os PRs agrupados por PBI e task, com o estado de cada item. PRs sem task aparecem num bloco de alerta no fim.

![Release em tela cheia](docs/images/release.png)

Para um PR sem task, **Vincular task** busca os work items pelo título do PR ou pelo que você digitar. O vínculo é gravado na plataforma (Azure DevOps ou Jira) e pode ser desfeito.

![Vincular uma task a um PR](docs/images/vincular-task.png)

## Formas de entrar

![Entrada por token pessoal](docs/images/entrada-token.png)

- **Token pessoal:** sempre disponível. Cada plataforma tem o próprio token, e o guia de escopos fica na tela de entrada.
  - **Azure DevOps:** organização e Personal Access Token. Fornece os PRs e os work items.
  - **GitHub:** organização (ou usuário) e fine-grained token. Fornece os PRs.
  - **Jira:** site, e-mail da conta e API token. Fornece as tasks dos PRs do GitHub.
- **Conta Microsoft:** aparece quando há um app registration do Microsoft Entra ID configurado. Vale só para o Azure DevOps. O passo a passo está em [`app/README.md`](app/README.md#conectar-ao-azure-devops).

As conexões se somam na mesma sessão. Para abrir o board é preciso o Azure DevOps ou o GitHub; com os dois conectados, o menu de contas escolhe de qual vêm os PRs.

## Como o token pessoal trafega

O token dá acesso à sua conta na plataforma, então o caminho dele é o ponto mais sensível da aplicação. Em resumo: ele sai do navegador cifrado, fica guardado cifrado, e só existe em claro na memória do servidor no instante de chamar a plataforma.

```mermaid
sequenceDiagram
    autonumber
    participant N as Navegador
    participant S as Servidor
    participant P as Plataforma<br/>(Azure DevOps, GitHub ou Jira)

    N->>S: GET /auth/pat/key
    S-->>N: chave pública RSA + nonce de uso único
    Note over N: Gera uma chave AES descartável,<br/>cifra { nonce, token } com AES-GCM<br/>e embrulha a chave AES com RSA-OAEP
    N->>S: POST /auth/pat/:plataforma (envelope cifrado)
    Note over S: Abre o envelope, confere e descarta o nonce,<br/>confere o formato do token
    S->>P: valida o token (quem é o dono, acesso à organização)
    P-->>S: dono do token
    Note over S: Sela o token com AES-256-GCM<br/>e guarda na sessão
    S-->>N: cookie de sessão (HttpOnly, sem o token)
    N->>S: chamadas seguintes, só com o cookie
    Note over S: Abre o token em memória<br/>só para a chamada
    S->>P: chamada com o token
```

### No envio

1. O navegador pede a chave pública do servidor. A resposta traz também um **nonce**, que vale para um único envio e por dois minutos.
2. O navegador gera uma chave AES-256 descartável e cifra `{ nonce, token }` com AES-GCM. A chave AES é embrulhada com RSA-OAEP (SHA-256) usando a chave pública.
3. Só esse envelope vai no corpo da requisição. O token não aparece em claro no corpo, em logs de proxy nem nas ferramentas de rede do navegador.

O par de chaves RSA é gerado a cada inicialização do servidor e vive só na memória do processo.

### No servidor

1. O envelope é aberto com a chave privada. O nonce precisa existir, estar no prazo e nunca ter sido usado; ele é descartado na hora. Um envelope capturado não pode ser reenviado.
2. O token é conferido (tamanho e apenas caracteres visíveis) e validado na própria plataforma, o que também revela de quem ele é.
3. O token é **selado com AES-256-GCM**, com uma chave derivada do `SESSION_SECRET`, e guardado assim na sessão em memória e no arquivo `.data/sessions.enc`.
4. A cada chamada à plataforma, o token é aberto em memória só para montar o cabeçalho da requisição. Ele nunca é gravado em log nem devolvido ao navegador.

### No navegador

Fica apenas o cookie de sessão: um identificador opaco, assinado, `HttpOnly` e `SameSite=Lax` (e `Secure` em HTTPS). O token não vai para `localStorage` nem para nenhum outro armazenamento.

### O que essa cifra não cobre

A cifra do envio é uma camada a mais, não um substituto do HTTPS. Sem TLS, quem altera o tráfego pode trocar a chave pública, e o cookie de sessão fica exposto. **Em produção, use HTTPS.**

### Outras proteções

- Limite de 60 tentativas de entrada por minuto, por IP.
- Escritas exigem um cabeçalho que outro site não consegue enviar (proteção contra CSRF).
- Cabeçalhos de segurança em toda resposta (Content-Security-Policy, `X-Frame-Options`, `nosniff`, `Referrer-Policy` e, em HTTPS, HSTS).
- Ids de projeto e repositório são validados e codificados antes de entrar no endereço da plataforma.

## Arquitetura

O servidor segue a arquitetura hexagonal: o núcleo define **portas** por capacidade e não conhece nenhuma plataforma. Cada plataforma é um **adapter** que implementa a porta.

```mermaid
flowchart LR
    Web["Front<br/>React + Tailwind"] -->|HTTP| Http

    subgraph Servidor
        Http["adapters/http<br/>rotas e sessão"] --> Casos["core/usecases<br/>board, releases, vínculos"]
        Casos --> SC(["porta<br/>SourceControl"])
        Casos --> WT(["porta<br/>WorkTracking"])
        Http --> IdP(["porta<br/>IdentityProvider"])
    end

    SC --> ADO["Azure DevOps"]
    SC --> GH["GitHub"]
    WT --> ADO
    WT --> Jira["Jira"]
    IdP --> Entra["Microsoft Entra ID"]
    SC -.-> Mem["memória<br/>(demonstração e testes)"]
    WT -.-> Mem
```

| Parte | Tecnologia |
|---|---|
| Servidor | Node.js, TypeScript, Fastify |
| Front | React 19, Vite, Tailwind CSS 4, TanStack Query, Radix UI |
| Validação das respostas da API no front | zod |
| Idiomas | Português, inglês e francês, pelo idioma do navegador |
| Testes | Vitest |

Para adicionar outra plataforma, implemente a porta correspondente em `app/server/src/adapters/` e registre em `registry.ts`. Os detalhes de como a release é montada em cada plataforma estão em [`app/README.md`](app/README.md#como-a-release-é-montada).
