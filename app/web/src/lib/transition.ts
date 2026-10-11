import { useNavigate } from 'react-router-dom';

// O roteador aplica a navegação como transição do React, fora do tempo do clique. A captura da
// tela nova tem de esperar a página de destino estar no DOM; sem isso, a troca acontece depois
// da captura e o fade não aparece.
function pageMounted(page: string): Promise<void> {
  return new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      if (document.querySelector(`[data-page="${page}"]`) || performance.now() - started > 600) resolve();
      else setTimeout(check, 8);
    };
    check();
  });
}

// Troca de tela com fade (View Transitions): a página atual some e a nova aparece.
// Onde a API não existe, ou com "reduzir movimento" ligado, a navegação é direta.
export function useViewNavigate() {
  const navigate = useNavigate();
  return (to: string) => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || typeof document.startViewTransition !== 'function') {
      navigate(to);
      return;
    }
    document.startViewTransition(() => {
      navigate(to);
      return pageMounted(to.startsWith('/release') ? 'release' : 'board');
    });
  };
}
