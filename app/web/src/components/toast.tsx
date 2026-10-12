import { CircleCheck, CircleX, X } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { toast as sonner, Toaster } from 'sonner';
import { t } from '../lib/i18n';

export interface ToastInput {
  kind: 'success' | 'error';
  title: string;
  description?: string;
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
      className="flex w-[400px] max-w-[calc(100vw-32px)] gap-3 rounded-xl bg-ink px-4 py-3.5 shadow-[0_12px_32px_#0F172A40]"
    >
      {toast.kind === 'success' ? (
        <CircleCheck size={18} className="shrink-0 text-[#4ADE80]" />
      ) : (
        <CircleX size={18} className="shrink-0 text-[#F87171]" />
      )}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <p className="text-[13.5px] font-semibold text-white">{toast.title}</p>
        {toast.description && <p className="text-[12.5px] leading-[1.4] text-[#CBD5E1]">{toast.description}</p>}
        {toast.action && (
          <button
            type="button"
            className="text-[12.5px] font-semibold text-[#A5B4FC] hover:text-white"
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
        <X size={16} />
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
        offset={{ bottom: 40, right: 32 }}
        mobileOffset={16}
        visibleToasts={3}
        gap={10}
        style={{ '--width': '400px' } as CSSProperties}
      />
    </>
  );
}

export function useToast(): ToastApi {
  return api;
}
