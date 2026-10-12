# Tour de onboarding

`onboarding.html` é um tour em seis passos: entrada com token pessoal do Azure DevOps, board de code review, filtro de revisor obrigatório, criação da branch de release, release em tela cheia e vínculo de task. Cada passo toca sozinho e para no fim; quem assiste avança com **Continuar** (ou →, Enter, espaço). **Voltar** (ou ←) refaz o passo anterior, e os números levam direto a qualquer passo. Clicar em Continuar no meio de um passo pula para o fim dele.

## Como é feito

As telas não são redesenhadas. Cada estado do fluxo foi capturado do app rodando, com o HTML e o CSS reais, em `snaps/`. O tour empilha essas capturas (cada uma num shadow DOM com o CSS do sistema) e anima a passagem de uma para a outra em CSS, com cursor, cliques e legendas por cima. As fontes do app ficam em `fonts/` e vão embutidas no HTML.

- Mudanças pequenas na mesma tela (marcar um PR, validar o token) são uma transição suave entre as duas capturas.
- Troca de página é como no app: a tela atual some, a nova aparece, e a barra do topo fica parada.
- Os toasts saem das capturas e entram como no sonner: sobem a própria altura com fade em 400 ms e saem descendo do mesmo jeito.
- Hover e foco são estados de verdade: na captura, os alvos do cursor ficam marcados com `data-tour`, e as regras do app para `:hover` e `:focus-within` também valem para `[data-hover]` e `[data-focus-within]`. O tour liga o atributo no elemento e o visual sai do CSS do sistema.
- O destaque do card de revisor opcional e do contador também é aplicado no próprio elemento, não por cima.
- As telas entram em tamanho natural (1366×768, tela de notebook comum). O quadro inteiro só encolhe se a janela do navegador for menor; nesse caso bordas finas podem sair com espessuras um pouco diferentes.
- Só o cursor e o anel de clique são desenhados por cima.

Os passos (título, texto e onde cada um termina) ficam em `STEPS`, no começo de `build.mjs`. Para mudar tempos, legendas ou o roteiro, edite e rode:

```bash
node design/onboarding/build.mjs
```

## Recapturar as telas

Se o visual do app mudar, as capturas precisam ser refeitas. O roteiro está em `capture.js`:

1. Suba a demonstração (`AUTH_MODE=demo`) e uma instância normal para a tela de token, com a janela em 1366×768.
2. Sirva esta pasta em `http://localhost:5180` com um servidor que aceite `POST /snap?name=<nome>` e grave o corpo em `snaps/<nome>.json` (e responda com CORS liberado).
3. No console de cada instância, importe o roteiro e rode a parte dela:

```js
const tour = await import('http://localhost:5180/capture.js');
await tour.token();   // instância normal, em /login, aba Token pessoal
await tour.board();   // demonstração, logado, no board
await tour.release(); // demonstração, em /release?repo=r-getnota-api, depois do board()
```

Depois, `node design/onboarding/build.mjs`. Na tela de token, a resposta do servidor é simulada no console para chegar ao estado validado sem um token real.
