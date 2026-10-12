import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { GitHubLogo, JiraLogo, MicrosoftLogo } from '../components/logos';
import { useToast } from '../components/toast';
import { cx } from '../components/ui';
import { useStoredState } from '../lib/format';
import { fetchAuthMode } from '../lib/pat';
import { useMe } from '../lib/session';
import { ENTRY_CARD_HEIGHT, PatConnectPage } from './PatConnectPage';
import { t } from '../lib/i18n';

// O servidor devolve o motivo em ?erro=, com os códigos em português da rota de callback.
const ERRORS: Record<string, () => string> = {
  cancelado: () => t('login.canceled'),
  falha: () => t('login.failed'),
};

function ProviderButton({ logo, label, onClick }: { logo: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="stroke flex h-12 w-full items-center justify-center gap-3 rounded-[10px] bg-white [--stroke:#D0D5DD] hover-surface"
    >
      {logo}
      <span className="text-[15px] font-medium text-ink">{label}</span>
    </button>
  );
}

type Method = 'microsoft' | 'pat';

const METHODS: { id: Method; label: () => string }[] = [
  { id: 'microsoft', label: () => t('login.signIn') },
  { id: 'pat', label: () => t('login.personalToken') },
];

function MethodSelector({ value, onChange }: { value: Method; onChange: (value: Method) => void }) {
  return (
    <div role="tablist" aria-label={t('login.methods')} className="flex gap-0.5 rounded-lg bg-[#EEF0F3] p-[3px]">
      {METHODS.map((method) => {
        const selected = method.id === value;
        return (
          <button
            key={method.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(method.id)}
            className={cx(
              'rounded-md px-3.5 py-[6px] text-[13px]',
              selected ? 'bg-white font-semibold text-ink shadow-[0_1px_2px_#0F172A14]' : 'font-medium text-mute hover:text-ink',
            )}
          >
            {method.label()}
          </button>
        );
      })}
    </div>
  );
}

// As duas formas de entrar convivem: conta Microsoft ou token pessoal. A última escolha fica guardada.
export function LoginPage() {
  const mode = useQuery({ queryKey: ['auth-mode'], queryFn: fetchAuthMode, staleTime: Infinity, retry: 1 });
  const me = useMe();
  const [stored, setStored] = useStoredState<Method | null>('rm.loginMethod', null);
  // Espera só a primeira resposta: sem sessão a consulta fica em erro e é refeita a cada montagem,
  // e esconder a tela nessas repetições a desmontaria em ciclo.
  if (mode.isPending || !me.isFetched) return null;

  const offers = mode.data ?? { microsoft: true, pat: false, demo: false, defaultOrganization: '' };
  // Quem já entrou com conta Microsoft não tem o que fazer aqui; quem conectou um token vem para trocá-lo.
  if (me.data && me.data.mode !== 'pat') return <Navigate to="/" replace />;

  const both = offers.pat && !offers.demo;
  // Sem escolha anterior, abre na forma que funciona: Microsoft quando configurado, senão o token.
  const preferred: Method = stored ?? (offers.microsoft ? 'microsoft' : 'pat');
  const method: Method = me.data?.mode === 'pat' ? 'pat' : both ? preferred : offers.microsoft ? 'microsoft' : 'pat';
  const selector = both ? <MethodSelector value={method} onChange={setStored} /> : undefined;

  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 overflow-x-clip px-4 py-4 short:gap-3 short:py-2">
      {selector}
      {/* A chave troca junto com o modo: o card novo aparece sob a cobertura (que alcança a sombra), e o seletor fica parado. */}
      <div key={method} className="fade-cover flex w-full justify-center [--cover-inset:-40px]">
        {method === 'pat' ? (
          <PatConnectPage defaultOrganization={offers.defaultOrganization} />
        ) : (
          <ProviderLoginPage available={offers.microsoft} />
        )}
      </div>
    </div>
  );
}

function ProviderLoginPage({ available }: { available: boolean }) {
  const toast = useToast();
  const [params] = useSearchParams();
  const error = ERRORS[params.get('erro') ?? '']?.();

  const unavailable = (provider: string) =>
    toast.show({
      kind: 'error',
      title: t('login.unavailable', { provider }),
      description: t('login.unavailableBody'),
    });

  return (
      <main
        className={cx(
          'stroke flex w-full max-w-[440px] flex-col items-center justify-center gap-9 rounded-2xl bg-white px-10 py-10 shadow-[0_12px_32px_#0F172A0F]',
          ENTRY_CARD_HEIGHT,
        )}
      >
        <div className="flex w-full flex-col items-center gap-5">
          <img src="/muralis-logo-full.png" alt="Muralis" className="h-[85px] w-[150px] object-contain" />
          <h1 className="text-2xl font-bold tracking-[-0.4px] text-ink">Release Management</h1>
        </div>
        <div className="flex w-full flex-col gap-3">
          {error && (
            <p role="alert" className="text-center text-[13px] leading-[1.45] text-[#B91C1C]">
              {error}
            </p>
          )}
          <ProviderButton
            logo={<MicrosoftLogo />}
            label={t('login.continueWith', { provider: 'Microsoft' })}
            onClick={() => (available ? window.location.assign('/auth/microsoft/login') : unavailable('Microsoft'))}
          />
          <ProviderButton logo={<GitHubLogo />} label={t('login.continueWith', { provider: 'GitHub' })} onClick={() => unavailable('GitHub')} />
          <ProviderButton logo={<JiraLogo />} label={t('login.continueWith', { provider: 'Jira' })} onClick={() => unavailable('Jira')} />
        </div>
      </main>
  );
}
