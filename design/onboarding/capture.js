// Roteiro de captura das telas do tour. Rode no console do app (janela de 1366×768, interface em português),
// com esta pasta servida em http://localhost:5180 aceitando POST /snap (veja o README):
//
//   const tour = await import('http://localhost:5180/capture.js');
//   await tour.token();    // na instância normal, em /login, aba Token pessoal
//   await tour.board();    // na demonstração (AUTH_MODE=demo), logado, no board
//   await tour.release();  // na demonstração, em /release?repo=r-getnota-api, logo depois do board()
//
// Cada captura guarda o HTML do body, os valores dos campos, a rolagem e a posição dos alvos do cursor.
// Os alvos ficam marcados com data-tour, para o tour aplicar hover e foco neles com o CSS do próprio app.

const SERVER = 'http://localhost:5180';
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(name, body) {
  await fetch(`${SERVER}/snap?name=${name}`, { method: 'POST', mode: 'no-cors', body: JSON.stringify(body) });
}

export async function snap(name, targets = {}) {
  for (const input of document.querySelectorAll('input')) input.setAttribute('value', input.value);
  for (const el of document.querySelectorAll('*')) {
    if (el.scrollTop > 0) el.setAttribute('data-st', String(el.scrollTop));
    else el.removeAttribute('data-st');
  }
  const rects = {};
  const marked = [];
  for (const [key, el] of Object.entries(targets)) {
    if (!el) {
      rects[key] = null;
      continue;
    }
    const r = el.getBoundingClientRect();
    rects[key] = [r.x, r.y, r.width, r.height].map((v) => +v.toFixed(1));
    el.setAttribute('data-tour', key);
    marked.push(el);
  }
  const body = document.body.cloneNode(true);
  for (const el of marked) el.removeAttribute('data-tour');
  body.querySelectorAll('script').forEach((script) => script.remove());
  await send(name, { name, w: innerWidth, h: innerHeight, html: body.innerHTML, targets: rects });
  return rects;
}

export async function css() {
  const text = [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      } catch {
        return '';
      }
    })
    .join('\n');
  await send('app-css', { css: text });
}

// Força o português, que é o idioma do tour, sem mexer no navegador.
export async function portuguese() {
  Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['pt-BR'] });
  dispatchEvent(new Event('languagechange'));
  await wait(1500);
}

const button = (text, root = document) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));

// Entrada com token: vazio, foco, token colado, validando e validado. A resposta do servidor é simulada, para chegar
// ao estado validado sem um token real.
export async function token() {
  await portuguese();
  const field = () => document.querySelector('#pat-token-azure-devops');
  const targets = () => ({ org: document.querySelector('#pat-organization'), token: field(), continue: button('Continuar') });
  await snap('a1-empty', targets());

  const real = window.fetch.bind(window);
  let connected = false;
  const me = {
    user: { name: 'Pedro Carlo', email: 'pedro.carlo@muralis.com.br' },
    demo: false,
    mode: 'pat',
    loginProvider: 'microsoft',
    organization: 'muralisti',
    source: { provider: 'azure-devops', name: 'Azure DevOps' },
    tracker: { provider: 'azure-devops', name: 'Azure DevOps' },
    accounts: [
      { provider: 'azure-devops', connected: true, active: true, handle: 'pedro.carlo@muralis.com.br', account: 'muralisti' },
      { provider: 'github', connected: false },
      { provider: 'jira', connected: false },
    ],
  };
  const json = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.includes('/auth/pat/azure-devops')) {
      await wait(4000);
      connected = true;
      return json({ provider: 'azure-devops', account: 'muralisti', user: { name: 'Pedro Carlo' } });
    }
    if (url.includes('/api/me') && connected) return json(me);
    return real(input, init);
  };

  field().focus();
  await wait(150);
  await snap('a2-focus', targets());
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setValue.call(field(), 'x'.repeat(84));
  field().dispatchEvent(new Event('input', { bubbles: true }));
  await wait(120);
  await snap('a3-pasted', targets());
  await wait(1300);
  await snap('a4-validating', targets());
  await wait(4200);
  await snap('a5-valid', targets());
  await css();
}

// Board: carregado, filtro de revisor obrigatório, dois PRs marcados, criando a branch e branch criada.
export async function board() {
  for (const key of Object.keys(localStorage)) if (key.startsWith('rm.')) localStorage.removeItem(key);
  await portuguese();
  await wait(1500);
  const column = () => document.querySelector('section[aria-label="Depende de mim"]');
  const merged = () => document.querySelector('section[aria-label="Mergeados"]');
  const targets = () => ({
    cardA: column()?.querySelectorAll('a')[0],
    cardOpt: column()?.querySelectorAll('a')[1],
    count: column()?.querySelector('header span.stroke'),
    scopeRequired: document.querySelector('[role=radio][aria-label*="obrigatório"]'),
    pick1: document.querySelector('[aria-label="Selecionar PR #1295"]'),
    pick2: document.querySelector('[aria-label="Selecionar PR #1294"]'),
    create: button('Criar branch', merged()),
    expand: document.querySelector('a[aria-label="Abrir release em tela cheia"]'),
  });
  await snap('b1-board', targets());
  targets().scopeRequired.click();
  await wait(700);
  await snap('b2-scope', targets());
  targets().pick1.click();
  await wait(500);
  await snap('b3-pick1', targets());
  targets().pick2.click();
  await wait(500);
  await snap('b4-pick2', targets());

  const real = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    if (String(input).endsWith('/releases') && init.method === 'POST') await wait(3500);
    return real(input, init);
  };
  targets().create.click();
  await wait(500);
  await snap('b5-creating', targets());
  await wait(4500);
  await snap('b6-created', targets());
  localStorage.removeItem('rm.reviewerScope');
  await css();
}

// Release em tela cheia: PR sem task, busca de tasks aberta e task vinculada.
export async function release() {
  await portuguese();
  await wait(1500);
  const targets = () => ({
    group: document.querySelector('[data-page=release] main button[aria-expanded]'),
    linkTask: button('Vincular task'),
    suggestion: document.querySelector('[role=option]'),
  });
  await snap('c1-release', targets());
  targets().linkTask.click();
  await wait(1500);
  await snap('c2-popover', targets());
  targets().suggestion.click();
  await wait(1600);
  await snap('c3-linked', targets());
}
