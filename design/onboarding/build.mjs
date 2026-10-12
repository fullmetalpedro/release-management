// Gera onboarding.html: um tour em passos (wizard) sobre telas reais do sistema, animado em CSS.
//
// As telas não são redesenhadas: cada estado do fluxo foi capturado do app rodando (HTML e CSS de verdade, em
// snaps/). O tour empilha essas capturas e anima a passagem entre elas, com cursor, cliques, toasts e legendas.
// Cada passo toca sozinho e para no fim; quem assiste avança com "Continuar".
// Cada captura vive num shadow DOM com o CSS do app, então nada do tour interfere no visual do sistema.
//
//   node design/onboarding/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, 'snaps', `${name}.json`), 'utf8'));
const b64 = (path) => readFileSync(path).toString('base64');

// ---------------------------------------------------------------- palco

const VIEW = { w: 1366, h: 768 }; // tamanho da janela em que as telas foram capturadas
const S = 1; // a tela entra em tamanho natural: bordas de 1 e 2 px saem iguais às do app
const CHROME = 34;
const PAD = 24;
const WIN = { w: VIEW.w, h: VIEW.h + CHROME };
const WIN_X = PAD;
const WIN_Y = 18;
const CAPTION_Y = WIN_Y + WIN.h + 14;
const FRAME = { w: WIN.w + PAD * 2, h: CAPTION_Y + 52 + 20 };

// Ponto da tela capturada (px da janela do app) para o palco.
const toStage = ([x, y]) => [WIN_X + x * S, WIN_Y + CHROME + y * S];
const rectOf = (snap, name) => {
  const rect = read(snap).targets[name];
  if (!rect) throw new Error(`${snap} não tem o alvo ${name}`);
  return rect;
};
const center = (snap, name, fx = 0.5, fy = 0.5) => {
  const [x, y, w, h] = rectOf(snap, name);
  return toStage([x + w * fx, y + h * fy]);
};
const box = (snap, name, pad = 0) => {
  const [x, y, w, h] = rectOf(snap, name);
  const [sx, sy] = toStage([x, y]);
  return `left:${(sx - pad).toFixed(1)}px;top:${(sy - pad).toFixed(1)}px;width:${(w * S + pad * 2).toFixed(1)}px;height:${(h * S + pad * 2).toFixed(1)}px`;
};

// ---------------------------------------------------------------- passos

const O = 1.8; // abertura; os tempos abaixo contam a partir dela

// Cada passo toca de onde o anterior parou até `end` (segundos) e espera o "Continuar".
const STEPS = [
  {
    end: 6.7,
    title: 'Conecte o Azure DevOps',
    text: 'Cole o token pessoal. A validação é automática: o campo fica verde e o Azure DevOps aparece como conectado.',
  },
  {
    end: 11.8,
    title: 'Veja o que depende de você',
    text: 'No board, a primeira coluna reúne os PRs que esperam o seu voto e os que aguardam você como autor.',
  },
  {
    end: 15.2,
    title: 'Fique só com o obrigatório',
    text: 'Neste PR o seu voto é opcional. Com o filtro de revisor obrigatório ele sai da coluna, e o contador cai de 4 para 3.',
  },
  {
    end: 23.2,
    title: 'Crie a branch de release',
    text: 'Marque os PRs mergeados e crie a branch: os cherry-picks são feitos para você.',
  },
  {
    end: 28.4,
    title: 'Abra a release em tela cheia',
    text: 'Os PRs da release aparecem agrupados por PBI e task. O que entrou sem task fica em destaque.',
  },
  {
    end: 34.4,
    title: 'Vincule a task que faltava',
    text: 'A busca já sugere tasks pelo título do PR. O vínculo também fica salvo no Azure DevOps.',
  },
];
const END = 35.6; // fechamento
const T = O + END + 1; // duração total da linha do tempo

// ---------------------------------------------------------------- linha do tempo

const pct = (sec) => `${Math.min(100, Math.max(0, (sec / T) * 100)).toFixed(3)}%`;
const EASE = 'cubic-bezier(.45,0,.2,1)';
const names = [];
let css = '';

// Uma faixa: valor inicial e trechos [início, fim, valor, easing?]. Entre os trechos o valor fica parado.
function track(cls, initial, segments) {
  const frames = [[0, initial, 'linear']];
  let prev = initial;
  for (const [start, end, value, ease] of segments) {
    const s = start + O;
    const e = Math.max(end + O, s + 0.02);
    frames.push([s, prev, ease ?? (end === start ? 'step-end' : EASE)]);
    frames.push([e, value, 'linear']);
    prev = value;
  }
  frames.push([T, prev, 'linear']);
  css += `@keyframes ${cls}{${frames.map(([sec, v, ease]) => `${pct(sec)}{${v};animation-timing-function:${ease}}`).join('')}}\n`;
  css += `.${cls}{animation:${cls} ${T}s both}\n`;
  names.push(cls);
}
const show = (cls, a, b, fade = 0.35) =>
  track(cls, 'opacity:0', [[a, a + fade, 'opacity:1'], ...(b === undefined ? [] : [[b, b + fade, 'opacity:0']])]);

// Telas, em ordem: [captura, quando entra, duração da transição, modo]. 'through' é troca de página, como no app:
// a tela atual some e depois a nova aparece. Sem modo, a nova entra suave por cima (mudança na mesma tela).
const SCREENS = [
  ['a1-empty', -O, 0],
  ['a2-focus', 1.8, 0.2, '', 'focus:token'],
  ['a3-pasted', 2.6, 0.25, '', 'focus:token'],
  ['a4-validating', 3.3, 0.35, '', 'focus:token'],
  ['a5-valid', 5.4, 0.6],
  ['b1-board', 8.5, 0.7, 'through'],
  ['b2-scope', 13.7, 0.35],
  ['b3-pick1', 16.45, 0.25],
  ['b4-pick2', 17.45, 0.25],
  ['b5-creating', 19.15, 0.3],
  ['b6-created', 21.5, 0.5],
  ['c1-release', 25.6, 0.7, 'through'],
  ['c2-popover', 29.85, 0.35],
  ['c3-linked', 31.95, 0.5],
];
SCREENS.forEach(([name, start, fade, mode], i) => {
  const next = SCREENS[i + 1];
  const segments = [];
  if (i > 0) {
    const from = mode === 'through' ? start + fade * 0.45 : start;
    segments.push([from, start + fade, 'opacity:1', 'cubic-bezier(.3,0,.2,1)']);
  }
  if (next) {
    if (next[3] === 'through') segments.push([next[1], next[1] + next[2] * 0.45, 'opacity:0', 'cubic-bezier(.4,0,1,1)']);
    else segments.push([next[1] + next[2] + 0.05, next[1] + next[2] + 0.05, 'opacity:0']);
  }
  track(`s-${name}`, i === 0 ? 'opacity:1' : 'opacity:0', segments);
});
// A barra do topo é a mesma no board e na release: fica parada enquanto o conteúdo troca, como no app.
const TOPBAR = { from: 'b6-created', at: 25.6, height: 56 * 0.9 };
track('topbar-hold', 'opacity:0', [[TOPBAR.at, TOPBAR.at, 'opacity:1'], [TOPBAR.at + 0.75, TOPBAR.at + 0.75, 'opacity:0']]);

// Toasts com a animação do sonner: entram subindo 100% da altura com fade, saem descendo do mesmo jeito (400 ms).
const TOASTS = [
  { name: 'tA', from: 'a5-valid', text: 'conectado em', in: 5.7, out: 8.3 },
  { name: 'tB', from: 'b6-created', text: 'criada', in: 21.6, out: 23.5 },
  { name: 'tC', from: 'c3-linked', text: 'vinculada', in: 32.1, out: END - 0.2 },
];
const TOAST_LIFT = 'translate:0 66px;opacity:0';
for (const toast of TOASTS) {
  track(toast.name, TOAST_LIFT, [
    [toast.in, toast.in + 0.4, 'translate:0 0;opacity:1', 'ease'],
    [toast.out, toast.out + 0.4, TOAST_LIFT, 'ease'],
  ]);
}

// Endereço da janela
track('url-login', 'opacity:1', [[8.5, 8.9, 'opacity:0']]);
show('url-board', 8.5, 25.6, 0.4);
show('url-release', 25.6, undefined, 0.4);

// ---------------------------------------------------------------- cursor

const P = {
  token: center('a1-empty', 'token', 0.3),
  continue: center('a5-valid', 'continue', 0.55, 0.55),
  cardA: center('b1-board', 'cardA', 0.55, 0.42),
  cardOpt: center('b1-board', 'cardOpt', 0.6, 0.3),
  scope: center('b1-board', 'scopeRequired'),
  pick1: center('b2-scope', 'pick1'),
  pick2: center('b3-pick1', 'pick2'),
  create: center('b4-pick2', 'create', 0.4),
  expand: center('b6-created', 'expand'),
  group: center('c1-release', 'group', 0.32),
  link: center('c1-release', 'linkTask', 0.45),
  suggestion: center('c2-popover', 'suggestion', 0.4),
};
const XY = ([x, y]) => `translate:${x.toFixed(1)}px ${y.toFixed(1)}px`;
const moves = [
  [0.4, 1.5, P.token],
  [6.9, 7.9, P.continue],
  [9.6, 10.6, P.cardA],
  [12.0, 12.8, P.cardOpt],
  [12.9, 13.5, P.scope],
  [15.3, 16.2, P.pick1],
  [16.7, 17.2, P.pick2],
  [17.9, 18.8, P.create],
  [19.8, 20.7, [760, 420]],
  [23.7, 24.8, P.expand],
  [26.6, 27.6, P.group],
  [28.4, 29.4, P.link],
  [30.4, 31.3, P.suggestion],
  [32.6, 33.8, [900, 460]],
];
const clicks = [1.75, 8.3, 13.65, 16.4, 17.4, 19.1, 25.4, 29.8, 31.9];

track('cur', XY([1150, 620]), moves.map(([a, b, p]) => [a, b, XY(p)]));
track('cur-press', 'scale:1', clicks.flatMap((c) => [[c - 0.1, c, 'scale:.82'], [c, c + 0.18, 'scale:1']]));
track(
  'cur-ring',
  'opacity:0;scale:.3',
  clicks.flatMap((c) => [[c, c, 'opacity:.55;scale:.3'], [c, c + 0.55, 'opacity:0;scale:1.8', 'cubic-bezier(.2,.6,.3,1)']]),
);

// Hover: a mesma captura com o elemento em hover, pelo CSS do app (data-hover no elemento marcado na captura).
const hovers = [
  ['h-continue', 'a5-valid', 'continue', 7.9, 8.35],
  ['h-card', 'b1-board', 'cardA', 10.6, 11.9],
  ['h-create', 'b4-pick2', 'create', 18.8, 19.15],
  ['h-expand', 'b6-created', 'expand', 24.8, 25.45],
  ['h-link', 'c1-release', 'linkTask', 29.4, 29.85],
];
for (const [cls, , , a, b] of hovers) show(cls, a, b, 0.15);

// Anotações do passo 3, aplicadas no próprio elemento da captura (não por cima dele).
const NOTES = [
  {
    cls: 'note-optional',
    from: 'b1-board',
    in: 11.95,
    out: 13.65,
    css: `[data-tour=cardOpt]{outline:2px dashed #f59e0b!important;outline-offset:2px!important;position:relative}
[data-tour=cardOpt]::before{content:'Revisor opcional';position:absolute;right:10px;top:-11px;z-index:2;background:#f59e0b;color:#fff;font-size:11px;font-weight:600;line-height:1;padding:4px 7px;border-radius:5px}`,
  },
  {
    cls: 'note-count',
    from: 'b2-scope',
    in: 13.75,
    out: 15.35,
    css: '[data-tour=count]{--stroke:#f59e0b!important;background-color:#fef3c7!important;color:#92400e!important}',
  },
];
for (const note of NOTES) show(note.cls, note.in, note.out, 0.3);

// ---------------------------------------------------------------- abertura, legendas e fechamento

track('intro', 'opacity:1', [[-0.8, -0.2, 'opacity:0'], [END - 0.7, END, 'opacity:1']]);
track('intro-a', 'opacity:1', [[END - 0.8, END - 0.8, 'opacity:0']]);
show('intro-b', END - 0.8, undefined, 0.01);

let previous = 0;
STEPS.forEach((step, i) => {
  step.start = previous;
  show(`cap${i + 1}`, previous + 0.05, step.end + 0.1, 0.35);
  show(`dot${i + 1}`, previous + 0.05, END, 0.3);
  previous = step.end;
});
track('progress', 'scale:0 1', [[-O, END, 'scale:1 1', 'linear']]);

// Paradas do wizard, em segundos absolutos: a abertura, o fim de cada passo e o fechamento.
const STOPS = [O - 1.0, ...STEPS.map((step) => O + step.end), O + END];

// ---------------------------------------------------------------- CSS do sistema

const fontFiles = Object.fromEntries(
  [
    'inter-latin-wght-normal.woff2',
    'inter-latin-ext-wght-normal.woff2',
    'jetbrains-mono-latin-wght-normal.woff2',
    'jetbrains-mono-latin-ext-wght-normal.woff2',
  ].map((file) => [file, b64(join(here, 'fonts', file))]),
);

// Separa o CSS capturado em blocos de topo, para mandar cada um ao lugar certo.
function topLevelBlocks(source) {
  const blocks = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        blocks.push(source.slice(start, i + 1).trim());
        start = i + 1;
      }
    } else if (ch === ';' && depth === 0) {
      blocks.push(source.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  return blocks.filter(Boolean);
}

const appCss = JSON.parse(readFileSync(join(here, 'snaps', 'app-css.json'), 'utf8')).css;
const documentCss = []; // @font-face e @property só valem no documento; o shadow DOM herda de lá
const shadowCss = [];
for (const block of topLevelBlocks(appCss)) {
  if (block.startsWith('@font-face')) {
    const file = block.match(/files\/([\w-]+\.woff2)/)?.[1];
    if (file && fontFiles[file]) {
      documentCss.push(block.replace(/url\([^)]*\)/, `url(data:font/woff2;base64,${fontFiles[file]})`));
    }
  } else if (block.startsWith('@property')) {
    documentCss.push(block);
  } else if (!block.startsWith('@import') && !block.includes('view-transition')) {
    shadowCss.push(block);
  }
}
// Dentro do shadow DOM, a raiz da página é o próprio host. Hover e foco não existem numa captura parada, então as
// regras do app para :hover e :focus-within valem também para [data-hover] e [data-focus-within]: o tour liga esses
// atributos no elemento real e o visual sai do CSS do próprio sistema.
const shadowSheet =
  shadowCss
    .join('\n')
    .replace(/(^|[\s,{}])(?::root|html|body)(?=[\s,{:.[])/g, '$1:host')
    .replace(/:hover\b/g, ':is(:hover,[data-hover])')
    .replace(/:focus-within\b/g, ':is(:focus-within,[data-focus-within])')
    .replace(/:focus-visible\b/g, ':is(:focus-visible,[data-focus-visible])') +
  '\n:host{display:block;width:100%;height:100%;overflow:hidden;font-family:var(--font-sans)}\n*{transition:none!important}';
// Camada de toast: só o toast fica visível, o resto da captura some (visibility é herdada e pode ser reaberta).
const toastSheet = ':host{background:transparent!important}*{visibility:hidden}[data-sonner-toaster],[data-sonner-toaster] *{visibility:visible}';

// ---------------------------------------------------------------- telas capturadas

const TOAST = /<li[^>]*data-sonner-toast=[\s\S]*?<\/li>/g;
// Tira os toasts da captura, menos o que tiver `keep` no texto (para a camada do toast).
const clean = (html, keep) =>
  html
    .replace(TOAST, (toast) => (keep && toast.includes(keep) ? toast : ''))
    .replace(/<img[^>]*src="\/api\/avatars[^"]*"[^>]*>/g, '');
const attr = (value) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const host = (cls, html, extra = '') => `<div class="snap ${cls}"${extra}><template data-snap>${html}</template></div>`;
const screens = [
  ...SCREENS.map(([name, , , , state]) => host(`s-${name}`, clean(read(name).html), state ? ` data-state="${state}"` : '')),
  ...hovers.map(([cls, snap, name]) => host(cls, clean(read(snap).html), ` data-state="hover:${name}"`)),
  ...NOTES.map((note) => host(note.cls, clean(read(note.from).html), ` data-css="${attr(note.css)}"`)),
  host('topbar-hold', clean(read(TOPBAR.from).html), ` style="clip-path:inset(0 0 ${VIEW.h - TOPBAR.height}px 0)"`),
  ...TOASTS.map((toast) => host(`toast ${toast.name}`, clean(read(toast.from).html, toast.text), ' data-toast')),
].join('\n');

// ---------------------------------------------------------------- página

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Release Management · Tour</title>
<style>
${documentCss.join('\n')}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#E9ECF1;font-family:'Inter Variable',Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{display:flex;align-items:center;justify-content:center;overflow:hidden}
button{font:inherit;cursor:pointer;border:0}
.frame{width:${FRAME.w}px;height:${FRAME.h}px;position:relative;overflow:hidden;background:#E9ECF1;zoom:var(--s,1);flex-shrink:0}
.window{position:absolute;left:${WIN_X}px;top:${WIN_Y}px;width:${WIN.w}px;height:${WIN.h}px;border-radius:12px;background:#F8F9FB;box-shadow:0 12px 32px #0F172A1A,0 0 0 1px #0F172A14;overflow:hidden}
.chrome{height:${CHROME}px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#F1F3F6;border-bottom:1px solid #E4E7EC}
.chrome>i{width:11px;height:11px;border-radius:50%}.chrome>i:nth-child(1){background:#FF5F57}.chrome>i:nth-child(2){background:#FEBC2E}.chrome>i:nth-child(3){background:#28C840}
.url{margin-left:18px;width:460px;height:23px;border-radius:7px;background:#fff;border:1px solid #E4E7EC;font-size:12px;color:#64748B;display:grid;align-items:center;padding:0 10px}.url>*{grid-area:1/1}
.screens{position:absolute;left:0;top:${CHROME}px;width:${VIEW.w}px;height:${VIEW.h}px;zoom:${S};contain:paint}
.snap{position:absolute;inset:0;background:#F8F9FB}.snap.toast{background:none;pointer-events:none}
.cur{position:absolute;left:0;top:0;width:0;height:0;z-index:30;pointer-events:none}
.cur-press{position:absolute;left:-3px;top:-2px;transform-origin:3px 2px;filter:drop-shadow(0 2px 3px #0F172A40)}
.cur-ring{position:absolute;left:-18px;top:-18px;width:36px;height:36px;border-radius:50%;border:2px solid #6366F1;background:#6366F133}
.caption{position:absolute;left:${WIN_X}px;right:${WIN_X}px;top:${CAPTION_Y}px;height:52px;display:flex;align-items:center;gap:16px}
.dots{display:flex;gap:5px}.dots button{position:relative;width:24px;height:24px;border-radius:50%;background:#E0E7FF;color:#4338CA;font-size:11px;font-weight:700;overflow:hidden}
.dots button i{position:absolute;inset:0;background:#4F46E5;color:#fff;display:flex;align-items:center;justify-content:center;font-style:normal}
.captext{position:relative;flex:1;height:50px}.captext>div{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center}
.captext b{font-size:17px;letter-spacing:-.2px;color:#0F172A}.captext p{font-size:14px;line-height:1.4;color:#475569;margin-top:2px}
.nav{display:flex;gap:8px;align-items:center}
.nav button{height:36px;padding:0 14px;border-radius:9px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}
.nav .back{background:#fff;color:#0F172A;outline:1px solid #D0D5DD}.nav .back:hover{background:#E9EDF2}
.nav .next{background:#0F172A;color:#fff}.nav .next:hover{background:#1E293B}
.nav button:disabled{opacity:.4;cursor:default}
.nav .next.waiting{box-shadow:0 0 0 0 #4F46E580;animation:nudge 1.6s ease-out infinite}
@keyframes nudge{0%{box-shadow:0 0 0 0 #4F46E580}70%,100%{box-shadow:0 0 0 10px #4F46E500}}
.bar{position:absolute;left:${WIN_X}px;right:${WIN_X}px;bottom:10px;height:3px;border-radius:2px;overflow:hidden;background:#D9DEF7}.progress{position:absolute;inset:0;background:#4F46E5;transform-origin:left}
.intro{position:absolute;inset:0;z-index:40;background:#E9ECF1;display:grid;place-items:center;text-align:center;color:#0F172A}
.intro>*{grid-area:1/1;display:flex;flex-direction:column;align-items:center}.intro h2{font-size:44px;letter-spacing:-1px}.intro p{font-size:18px;color:#475569;margin-top:12px}.intro small{display:block;margin-bottom:14px;font-size:12px;color:#64748B;letter-spacing:2px;text-transform:uppercase}
.frame:not([data-edge]) .intro{pointer-events:none}
.intro button{margin-top:30px;height:46px;padding:0 24px;border-radius:10px;background:#0F172A;color:#fff;font-size:15px;font-weight:600}.intro button:hover{background:#1E293B}
.hint{position:absolute;right:${WIN_X}px;bottom:8px;font-size:11px;color:#94A3B8}
${css}
</style>
</head>
<body>
<div class="frame" id="frame">
  <div class="window">
    <div class="chrome"><i></i><i></i><i></i><div class="url"><span class="url-login">www.release-management.com/login</span><span class="url-board">www.release-management.com/</span><span class="url-release">www.release-management.com/release?repo=invoicing-api</span></div></div>
    <div class="screens">
${screens}
    </div>
  </div>
  <div class="caption">
    <div class="dots">${STEPS.map((_, i) => `<button type="button" data-step="${i + 1}" aria-label="Passo ${i + 1}">${i + 1}<i class="dot${i + 1}">${i + 1}</i></button>`).join('')}</div>
    <div class="captext">${STEPS.map((step, i) => `<div class="cap${i + 1}"><b>${step.title}</b><p>${step.text}</p></div>`).join('')}</div>
    <div class="nav"><button type="button" class="back" id="back">Voltar</button><button type="button" class="next" id="next">Continuar →</button></div>
  </div>
  <div class="bar"><i class="progress"></i></div>
  <div class="cur"><div class="cur-ring"></div><svg class="cur-press" width="22" height="26" viewBox="0 0 22 26"><path d="M3 2 L3 20 L8 15.5 L11.5 23.5 L15 22 L11.5 14 L18 14 Z" fill="#0F172A" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
  <div class="intro">
    <div class="intro-a"><small>Tour</small><h2>Release Management</h2><p>Do token pessoal à análise da release, em ${STEPS.length} passos.</p><button type="button" id="start">Começar</button></div>
    <div class="intro-b"><small>Pronto</small><h2>Code review e releases num só lugar</h2><p>Board, branch de release e vínculo de tasks, sem sair da ferramenta.</p><button type="button" id="again">Ver de novo</button></div>
  </div>
</div>
<script>
  // Monta as telas capturadas, cada uma no próprio shadow DOM com o CSS do sistema.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(${JSON.stringify(shadowSheet).replace(/<\//g, '<\\/')});
  const toastSheet = new CSSStyleSheet();
  toastSheet.replaceSync(${JSON.stringify(toastSheet)});
  for (const template of document.querySelectorAll('template[data-snap]')) {
    const host = template.parentElement;
    const shadow = host.attachShadow({ mode: 'open' });
    const sheets = host.hasAttribute('data-toast') ? [sheet, toastSheet] : [sheet];
    if (host.dataset.css) {
      const note = new CSSStyleSheet();
      note.replaceSync(host.dataset.css);
      sheets.push(note);
    }
    shadow.adoptedStyleSheets = sheets;
    shadow.append(template.content.cloneNode(true));
    template.remove();
    // Hover e foco no elemento real: o CSS do app reage aos atributos como reagiria ao mouse e ao teclado.
    const [state, target] = (host.dataset.state ?? '').split(':');
    const el = target && shadow.querySelector('[data-tour="' + target + '"]');
    if (el && state === 'hover') el.setAttribute('data-hover', '');
    if (el && state === 'focus') for (let node = el; node instanceof Element; node = node.parentElement) node.setAttribute('data-focus-within', '');
    for (const el of shadow.querySelectorAll('[data-st]')) el.scrollTop = Number(el.dataset.st);
  }

  // Wizard: a animação é toda CSS, numa linha do tempo só. O script toca de uma parada até a próxima e espera.
  const NAMES = new Set(${JSON.stringify(names)});
  const STOPS = ${JSON.stringify(STOPS.map((s) => +s.toFixed(3)))};
  const tour = () => document.getAnimations().filter((a) => NAMES.has(a.animationName));
  const next = document.getElementById('next');
  const back = document.getElementById('back');
  let stop = 0; // índice da parada em que o tour está (ou para onde está indo)
  let timer;
  let playing = false;

  const seek = (sec) => { for (const a of tour()) { a.pause(); a.currentTime = sec * 1000; } };
  const settle = () => {
    playing = false;
    seek(STOPS[stop]);
    next.classList.add('waiting');
    next.disabled = stop >= STOPS.length - 1;
    back.disabled = stop <= 1;
    // Abertura e fechamento cobrem o palco e recebem os cliques; no meio do tour, não.
    frame.toggleAttribute('data-edge', stop === 0 || stop === STOPS.length - 1);
  };
  // Toca da parada atual até a seguinte.
  const advance = () => {
    if (playing) { clearTimeout(timer); settle(); return; } // no meio de um passo, "Continuar" pula para o fim dele
    if (stop >= STOPS.length - 1) return;
    const from = STOPS[stop];
    stop += 1;
    seek(from);
    for (const a of tour()) a.play();
    playing = true;
    frame.removeAttribute('data-edge');
    next.classList.remove('waiting');
    timer = setTimeout(settle, (STOPS[stop] - from) * 1000);
  };
  // Refaz um passo: volta ao começo dele e toca de novo.
  const replay = (index) => { clearTimeout(timer); playing = false; stop = Math.max(0, index - 1); advance(); };

  next.onclick = advance;
  back.onclick = () => replay(Math.max(1, playing ? stop - 1 : stop - 1));
  // Os dois botões do cartão ficam empilhados; o que vale depende de onde o tour está.
  const edge = () => (stop >= STOPS.length - 1 ? replay(1) : advance());
  document.getElementById('start').onclick = edge;
  document.getElementById('again').onclick = edge;
  for (const dot of document.querySelectorAll('[data-step]')) dot.onclick = () => replay(Number(dot.dataset.step));
  addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); advance(); }
    if (event.key === 'ArrowLeft') back.click();
  });
  const frame = document.getElementById('frame');
  const fit = () => frame.style.setProperty('--s', Math.min(1, innerWidth / ${FRAME.w}, innerHeight / ${FRAME.h}).toFixed(4));
  settle();
  addEventListener('resize', fit); fit();
</script>
</body>
</html>
`;

writeFileSync(join(here, 'onboarding.html'), html);
console.log(`onboarding.html gerado: ${(html.length / 1024).toFixed(0)} KB, ${SCREENS.length} telas, ${STEPS.length} passos`);
