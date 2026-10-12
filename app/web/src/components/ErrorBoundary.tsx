import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../lib/i18n';

// Última barreira: um erro de renderização mostra um aviso com saída, em vez de deixar a tela em branco.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <p className="text-sm font-medium text-ink">{t('common.crashed')}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="hover-primary rounded-lg bg-ink px-3.5 py-2 text-[0.8125rem] font-semibold text-white"
        >
          {t('common.reload')}
        </button>
      </div>
    );
  }
}
