import { BellRing, CircleCheck, CircleX, X } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { toast as sonner, Toaster } from 'sonner';
import { t } from '../lib/i18n';
import { rem } from '../lib/units';

export interface ToastInput {
  kind: 'success' | 'error' | 'info';
  title: string;
  description?: string;
  // Lista curta abaixo do título, como os PRs que acabaram de chegar.
  items?: string[];
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  show: (toast: ToastInput) => void;
  dismiss: () => void;
}

const DURATION_MS = 9000;

// Fila, entrada, saída e arrastar para fechar ficam com o sonner; aqui só o desenho do cartão.
function ToastCard({ id, toast }: { id: string | number; toast: ToastInput }) {
  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      className="flex w-[25rem] max-w-[calc(100vw-2rem)] gap-3 rounded-xl bg-ink px-4 py-3.5 shadow-[0_0.75rem_2rem_#0F172A40]"
    >
      {toast.kind === 'success' ? (
        <CircleCheck size={rem(18)} className="shrink-0 text-[#4ADE80]" />
      ) : toast.kind === 'info' ? (
        <BellRing size={rem(18)} className="shrink-0 text-[#FBBF24]" />
      ) : (
        <CircleX size={rem(18)} className="shrink-0 text-[#F87171]" />
      )}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <p className="text-[0.84375rem] font-semibold text-white">{toast.title}</p>
        {toast.description && <p className="text-[0.78125rem] leading-[1.4] text-[#CBD5E1]">{toast.description}</p>}
        {toast.items && (
          <ul className="flex w-full flex-col gap-0.5">
            {toast.items.map((item) => (
              <li key={item} className="truncate text-[0.78125rem] leading-[1.4] text-[#CBD5E1]">
                {item}
              </li>
            ))}
          </ul>
        )}
        {toast.action && (
          <button
            type="button"
            className="text-[0.78125rem] font-semibold text-[#A5B4FC] hover:text-white"
            onClick={() => {
              sonner.dismiss(id);
              toast.action!.onClick();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={t('common.close')}
        onClick={() => sonner.dismiss(id)}
        className="h-4 shrink-0 text-mute hover:text-white"
      >
        <X size={rem(16)} />
      </button>
    </div>
  );
}

const api: ToastApi = {
  show: (toast) => {
    sonner.custom((id) => <ToastCard id={id} toast={toast} />, { duration: DURATION_MS });
  },
  dismiss: () => {
    sonner.dismiss();
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster
        position="bottom-right"
        offset={{ bottom: rem(40), right: rem(32) }}
        mobileOffset={rem(16)}
        visibleToasts={3}
        gap={9}
        style={{ '--width': '25rem' } as CSSProperties}
      />
    </>
  );
}

export function useToast(): ToastApi {
  return api;
}
