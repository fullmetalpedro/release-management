import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  Check,
  CircleCheck,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  LoaderCircle,
  Repeat2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { AzureDevOpsLogo, GitHubLogo, JiraLogo } from '../components/logos';
import { useToast } from '../components/toast';
import { cx } from '../components/ui';
import type { Me, ProviderId } from '../lib/api';
import { connectPlatform, type PlatformAccount } from '../lib/pat';
import { useMe } from '../lib/session';
import { t } from '../lib/i18n';
import { rem } from '../lib/units';

interface Guide {
  title: string;
  description: string;
  link: (organization: string) => { label: string; href: string };
  steps: [string, string, string, string, string];
  scopes: { name: string; level: string; description: string; mono?: boolean; write?: boolean }[];
  note: string;
}

// Azure DevOps sempre primeiro, em todos os seletores do sistema.
const PLATFORMS: { id: ProviderId; name: string; logo: (size: number) => ReactNode }[] = [
  { id: 'azure-devops', name: 'Azure DevOps', logo: (size) => <AzureDevOpsLogo size={size} /> },
  { id: 'github', name: 'GitHub', logo: (size) => <GitHubLogo size={size} /> },
  { id: 'jira', name: 'Jira', logo: (size) => <JiraLogo size={size} /> },
];

// Chave de cada plataforma no catálogo.
const CATALOG_KEY: Record<ProviderId, 'azureDevOps' | 'github' | 'jira'> = {
  'azure-devops': 'azureDevOps',
  github: 'github',
  jira: 'jira',
};

// O que não muda com o idioma: endereços, escopos que dão escrita e nomes técnicos em fonte mono.
const GUIDE_LINKS: Record<ProviderId, Guide['link']> = {
  'azure-devops': (organization) => ({
    label: `dev.azure.com/${organization || '{org}'}/_usersSettings/tokens`,
    href: organization
      ? `https://dev.azure.com/${encodeURIComponent(organization)}/_usersSettings/tokens`
      : 'https://dev.azure.com',
  }),
  github: () => ({
    label: 'github.com/settings/personal-access-tokens/new',
    href: 'https://github.com/settings/personal-access-tokens/new',
  }),
  jira: () => ({
    label: 'id.atlassian.com/manage-profile/security/api-tokens',
    href: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  }),
};
const WRITE_SCOPES: Record<ProviderId, boolean[]> = {
  'azure-devops': [true, true, false],
  github: [true, false, false],
  jira: [false, true, false],
};

function guideFor(provider: ProviderId): Guide {
  const base = `pat.guides.${CATALOG_KEY[provider]}`;
  const scopes = t(`${base}.scopes`, { returnObjects: true }) as unknown as Guide['scopes'];
  return {
    title: t(`${base}.title`),
    description: t(`${base}.description`),
    link: GUIDE_LINKS[provider],
    steps: t(`${base}.steps`, { returnObjects: true }) as unknown as Guide['steps'],
    scopes: scopes.map((scope, index) => ({ ...scope, write: WRITE_SCOPES[provider][index], mono: provider === 'jira' })),
    note: t(`${base}.note`),
  };
}

function GuideStep({ number, text, children }: { number: number; text: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="stroke flex h-[1.375rem] w-[1.375rem] shrink-0 items-center justify-center rounded-full bg-white text-[0.71875rem] font-bold text-ink-2 [--stroke:#CBD5E1]">
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2.5 pt-0.5">
        <p className="text-[0.84375rem] leading-[1.5] text-ink-2">{text}</p>
        {children}
      </div>
    </li>
  );
}

function TokenGuide({ tab, onTab, organization }: { tab: ProviderId; onTab: (tab: ProviderId) => void; organization: string }) {
  // O guia mostrado segue a aba com um pequeno atraso: a cobertura fecha sobre o guia antigo,
  // o conteúdo troca escondido e ela abre de novo. Sem isso o guia antigo sumia de uma vez.
  const [shown, setShown] = useState(tab);
  useEffect(() => {
    if (tab === shown) return;
    const timer = setTimeout(() => setShown(tab), 130);
    return () => clearTimeout(timer);
  }, [tab, shown]);
  const guide = guideFor(shown);
  const link = guide.link(organization);
  return (
    <aside className="flex w-full shrink-0 flex-col gap-5 border-t border-line bg-canvas px-9 py-7 short:py-5 lg:w-[42.5rem] lg:border-l lg:border-t-0">
      <div role="tablist" aria-label={t('pat.guideTabs')} className="flex gap-[0.1875rem] rounded-[0.625rem] bg-[#EEF0F3] p-[0.1875rem]">
        {PLATFORMS.map((platform) => {
          const selected = platform.id === tab;
          return (
            <button
              key={platform.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onTab(platform.id)}
              className={cx(
                'flex h-8 flex-1 basis-0 items-center justify-center gap-1.5 rounded-lg text-[0.78125rem]',
                selected ? 'bg-white font-semibold text-ink shadow-[0_1px_0.1875rem_#0F172A14]' : 'font-medium text-mute hover:text-ink',
              )}
            >
              <span className={cx('flex', !selected && 'opacity-60')}>{platform.logo(13)}</span>
              {platform.name}
            </button>
          );
        })}
      </div>

      {/* Quem anima é a cobertura, da cor do fundo; o texto fica parado e não muda de nitidez. */}
      <div className="relative flex flex-col gap-5">
      <div
        aria-hidden
        className={cx(
          'pointer-events-none absolute -inset-1 z-10 bg-canvas transition-opacity ease-out',
          tab !== shown ? 'opacity-100 duration-[120ms]' : 'opacity-0 duration-200',
        )}
      />
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-bold tracking-[-0.2px] text-ink">{guide.title}</h2>
        <p className="text-[0.84375rem] leading-[1.5] text-mute">{guide.description}</p>
      </div>

      {/* Passos 1 a 3 numa coluna, 4 e 5 na outra: o guia usa a largura em vez de empilhar tudo. */}
      <div className="grid grid-cols-1 gap-x-7 gap-y-[1.125rem] md:grid-cols-2">
      <ol className="flex flex-col gap-[1.125rem]">
        <GuideStep number={1} text={guide.steps[0]}>
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="stroke flex max-w-full items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 hover-surface"
          >
            <span className="min-w-0 break-all font-mono text-[0.71875rem] font-medium leading-[1.4] text-[#1E40AF]">{link.label}</span>
            <ExternalLink size={rem(12)} className="shrink-0 text-[#1E40AF]" />
          </a>
        </GuideStep>
        <GuideStep number={2} text={guide.steps[1]} />
        <GuideStep number={3} text={guide.steps[2]} />
      </ol>
      <ol start={4} className="flex flex-col gap-[1.125rem]">
        <GuideStep number={4} text={guide.steps[3]}>
          <ul className="stroke flex w-full flex-col rounded-[0.625rem] bg-white">
            {guide.scopes.map((scope, index) => (
              <li
                key={scope.name}
                className={cx('flex gap-2.5 px-3 py-[0.5625rem]', index < guide.scopes.length - 1 && 'border-b border-line-soft')}
              >
                <span className="flex h-[1.125rem] w-[1.125rem] shrink-0 items-center justify-center rounded-[0.3125rem] bg-ink">
                  <Check size={rem(12)} className="text-white" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cx('text-[0.8125rem] font-semibold text-ink', scope.mono && 'font-mono text-[0.78125rem]')}>{scope.name}</span>
                    <span
                      className={cx(
                        'whitespace-nowrap rounded-full px-2 py-0.5 text-[0.71875rem] font-semibold',
                        scope.write ? 'bg-[#DBEAFE] text-[#1E40AF]' : 'bg-[#F1F5F9] text-ink-2',
                      )}
                    >
                      {scope.level}
                    </span>
                  </div>
                  <p className="text-xs leading-[1.4] text-mute">{scope.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </GuideStep>
        <GuideStep number={5} text={guide.steps[4]} />
      </ol>
      </div>

      <div className="stroke flex gap-2.5 rounded-[0.625rem] bg-[#FFFBEB] px-3.5 py-3 [--stroke:#FDE68A]">
        <Info size={rem(16)} className="shrink-0 text-[#B45309]" />
        <p className="text-[0.78125rem] leading-[1.45] text-[#92400E]">{guide.note}</p>
      </div>
      </div>
    </aside>
  );
}

function PlatformRow({
  logo,
  name,
  sub,
  connected,
  expanded,
  hint,
  onToggle,
  children,
}: {
  logo: ReactNode;
  name: string;
  sub: string;
  connected: boolean;
  expanded: boolean;
  // O que o clique faz, quando não é óbvio ("Trocar", "Fechar").
  hint?: string;
  // Sem ação, o cabeçalho não é clicável (a única plataforma aberta antes da primeira conexão).
  onToggle?: () => void;
  children?: ReactNode;
}) {
  const Header = onToggle ? 'button' : 'div';
  return (
    <section
      aria-label={name}
      className={cx(
        'flex flex-col rounded-xl bg-white',
        expanded ? 'outline-[1.5px] outline-offset-[-0.75px] outline-ink' : 'stroke',
      )}
    >
      {/* O cabeçalho inteiro abre e fecha a plataforma. */}
      <Header
        {...(onToggle ? { type: 'button', 'aria-expanded': expanded, onClick: onToggle } : {})}
        className={cx('flex items-center gap-3 rounded-xl p-4 text-left', onToggle && !expanded && 'hover-surface')}
      >
        <span className="stroke flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas">{logo}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[0.9375rem] font-semibold text-ink">{name}</span>
          <span className="truncate text-[0.78125rem] text-mute">{sub}</span>
        </div>
        {connected && (
          <span className="flex items-center gap-[0.3125rem] rounded-full bg-[#DCFCE7] py-[0.1875rem] pl-[0.4375rem] pr-[0.5625rem]">
            <CircleCheck size={rem(12)} className="text-[#166534]" />
            <span className="text-xs font-semibold text-[#166534]">{t('pat.connected')}</span>
          </span>
        )}
        {hint && <span className="text-[0.8125rem] font-semibold text-mute">{hint}</span>}
      </Header>
      {/* O formulário abre e fecha deslizando: a linha da grade vai de 0 à altura do conteúdo. */}
      <div
        inert={!expanded}
        className={cx(
          'grid transition-[grid-template-rows] duration-200 ease-out',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-4 pb-4">{children}</div>
        </div>
      </div>
    </section>
  );
}

// Altura comum aos dois cards da tela de entrada (login e token), para a troca de modo não mudar a altura.
// Vale só lado a lado; empilhado em telas estreitas, o card do token segue o conteúdo.
export const ENTRY_CARD_HEIGHT = 'lg:h-[43.875rem] lg:short:h-[40.5rem]';

const EMAIL = /^\S+@\S+\.\S+$/;

type FieldName = 'organization' | 'owner' | 'site' | 'email';

interface FormSpec {
  fields: { name: FieldName; label: string; prefix?: string; placeholder?: string; autoComplete?: string }[];
  tokenLabel: string;
  hint: string;
  account: (values: Record<FieldName, string>) => PlatformAccount;
  // Endereço da conta conectada, mostrado na linha da plataforma.
  address: (account: string) => string;
}

// Rótulos lidos na renderização, no idioma atual.
const FORMS: Record<ProviderId, FormSpec> = {
  'azure-devops': {
    get fields() {
      return [
        { name: 'organization' as const, label: t('pat.forms.azureDevOps.organization'), prefix: 'dev.azure.com/', autoComplete: 'organization' },
      ];
    },
    get tokenLabel() {
      return t('pat.forms.azureDevOps.token');
    },
    get hint() {
      return t('pat.forms.azureDevOps.hint');
    },
    account: (values) => ({ organization: values.organization.trim() }),
    address: (account) => `dev.azure.com/${account}`,
  },
  github: {
    get fields() {
      return [{ name: 'owner' as const, label: t('pat.forms.github.owner'), prefix: 'github.com/', autoComplete: 'organization' }];
    },
    get tokenLabel() {
      return t('pat.forms.github.token');
    },
    get hint() {
      return t('pat.forms.github.hint');
    },
    account: (values) => ({ organization: values.owner.trim() }),
    address: (account) => `github.com/${account}`,
  },
  jira: {
    get fields() {
      return [
        { name: 'site' as const, label: t('pat.forms.jira.site'), placeholder: t('pat.forms.jira.sitePlaceholder'), autoComplete: 'url' },
        { name: 'email' as const, label: t('pat.forms.jira.email'), placeholder: t('pat.forms.jira.emailPlaceholder'), autoComplete: 'email' },
      ];
    },
    get tokenLabel() {
      return t('pat.forms.jira.token');
    },
    get hint() {
      return t('pat.forms.jira.hint');
    },
    account: (values) => ({ site: values.site.trim(), email: values.email.trim() }),
    address: (account) => account,
  },
};

function ConnectForm({
  provider,
  name,
  active,
  values,
  onChange,
  onFocus,
  onConnected,
}: {
  provider: ProviderId;
  name: string;
  // O formulário fica montado mesmo fechado, para a linha poder deslizar.
  active: boolean;
  values: Record<FieldName, string>;
  onChange: (field: FieldName, value: string) => void;
  onFocus: () => void;
  onConnected: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const spec = FORMS[provider];
  const [token, setToken] = useState('');
  const [reveal, setReveal] = useState(false);
  // Token aceito: o campo fica verde, com o token ainda lá (mascarado), até o usuário digitar outro.
  const [validated, setValidated] = useState(false);
  const validatedRef = useRef(validated);
  validatedRef.current = validated;
  // Fechou sem conectar: o token digitado e não aceito não fica guardado no formulário escondido.
  useEffect(() => {
    if (active) return;
    setReveal(false);
    if (!validatedRef.current) setToken('');
  }, [active]);

  const connect = useMutation({
    mutationFn: () => connectPlatform(provider, spec.account(values), token.trim()),
    onSuccess: async (result) => {
      setReveal(false);
      setValidated(true);
      // Dados da conta anterior não valem para a nova conexão. A sessão é só recarregada, sem ser
      // zerada: zerar desmontaria a tela de entrada inteira por um instante.
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth-mode' && query.queryKey[0] !== 'me' });
      await queryClient.refetchQueries({ queryKey: ['me'] });
      onConnected();
      toast.show({
        kind: 'success',
        title: t('pat.connectedToast', { name, account: result.account }),
        description: t('pat.connectedToastBody', { user: result.user.name }),
      });
    },
  });

  // Mudar a conta invalida o "aceito": o token foi validado para a conta anterior.
  const account = JSON.stringify(spec.account(values));
  const validatedAccount = useRef(account);
  useEffect(() => {
    if (validated && validatedAccount.current !== account) setValidated(false);
    if (!validated) validatedAccount.current = account;
  }, [account, validated]);

  const resetConnect = connect.reset;
  useEffect(() => {
    if (!active) resetConnect();
  }, [active, resetConnect]);

  const complete =
    spec.fields.every((field) => (field.name === 'email' ? EMAIL.test(values.email.trim()) : values[field.name].trim() !== '')) &&
    token.trim().length >= 20;
  // Não há botão: a validação dispara sozinha quando os campos estão preenchidos e a digitação para.
  // Cada combinação é tentada uma vez; depois de um erro, só volta a tentar quando algo muda.
  const attempt = JSON.stringify([spec.account(values), token.trim()]);
  const tried = useRef('');
  const validate = connect.mutate;
  const pending = connect.isPending;
  useEffect(() => {
    if (!active || !complete || pending || tried.current === attempt) return;
    const timer = setTimeout(() => {
      tried.current = attempt;
      validate();
    }, 600);
    return () => clearTimeout(timer);
  }, [active, complete, pending, attempt, validate]);
  const errorId = `pat-error-${provider}`;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        // Enter valida na hora, e também repete uma tentativa que falhou.
        if (complete && !pending) {
          tried.current = attempt;
          validate();
        }
      }}
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          {spec.fields.map((field) => (
            <div key={field.name} className="flex min-w-0 flex-1 basis-0 flex-col gap-1.5">
              <label htmlFor={`pat-${field.name}`} className="text-[0.78125rem] font-medium text-ink-2">
                {field.label}
              </label>
              <div className="stroke flex h-10 items-center rounded-lg bg-white px-3 [--stroke:#CBD5E1] focus-within:[--stroke:#0F172A]">
                {field.prefix && <span className="font-mono text-[0.8125rem] text-faint">{field.prefix}</span>}
                <input
                  id={`pat-${field.name}`}
                  value={values[field.name]}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  onFocus={onFocus}
                  placeholder={field.placeholder}
                  autoComplete={field.autoComplete}
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[0.8125rem] font-medium text-ink outline-none placeholder:font-normal placeholder:text-faint"
                />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`pat-token-${provider}`} className="text-[0.78125rem] font-medium text-ink-2">
            {spec.tokenLabel}
          </label>
          <div
            className={cx(
              'stroke flex h-10 items-center gap-2 rounded-lg px-3',
              connect.isError
                ? 'bg-white [--stroke:#DC2626]'
                : validated
                  ? 'bg-[#F0FDF4] [--stroke:#16A34A]'
                  : 'bg-white [--stroke:#CBD5E1] focus-within:[--stroke:#0F172A]',
            )}
          >
            <KeyRound size={rem(15)} className={cx('shrink-0', validated ? 'text-[#16A34A]' : 'text-mute')} />
            <input
              id={`pat-token-${provider}`}
              type={reveal ? 'text' : 'password'}
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                setValidated(false);
              }}
              onFocus={onFocus}
              readOnly={pending}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={connect.isError}
              aria-describedby={connect.isError ? errorId : undefined}
              className="min-w-0 flex-1 bg-transparent font-mono text-[0.8125rem] leading-[1.2] text-ink outline-none"
            />
            {!pending && (
              <button
                type="button"
                aria-label={reveal ? t('pat.hideToken') : t('pat.showToken')}
                aria-pressed={reveal}
                onClick={() => setReveal(!reveal)}
                className="shrink-0 text-faint hover:text-ink-2"
              >
                {reveal ? <EyeOff size={rem(16)} /> : <Eye size={rem(16)} />}
              </button>
            )}
            {pending && (
              <LoaderCircle size={rem(16)} role="status" aria-label={t('pat.validating')} className="shrink-0 animate-spin text-mute" />
            )}
            {validated && !pending && (
              <CircleCheck size={rem(16)} role="img" aria-label={t('pat.validated')} className="shrink-0 text-[#16A34A]" />
            )}
          </div>
          {connect.isError && (
            <p id={errorId} role="alert" className="text-[0.78125rem] leading-[1.4] text-[#B91C1C]">
              {connect.error.message}
            </p>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <Repeat2 size={rem(14)} className="mt-0.5 shrink-0 text-mute" />
        <p className="text-[0.78125rem] leading-[1.4] text-mute">{spec.hint}</p>
      </div>
    </form>
  );
}

const NO_ACCOUNTS: Me['accounts'] = [];

export function PatConnectPage({ defaultOrganization }: { defaultOrganization: string }) {
  const me = useMe();
  const navigate = useNavigate();
  const accounts = me.data?.mode === 'pat' ? me.data.accounts : NO_ACCOUNTS;
  const accountOf = (provider: ProviderId) => accounts.find((account) => account.provider === provider && account.connected);
  const connectedCount = accounts.filter((account) => account.connected).length;
  // Os PRs vêm do Azure DevOps ou do GitHub; só o Jira não abre o board.
  const hasSource = !!accountOf('azure-devops') || !!accountOf('github');

  const [guideTab, setGuideTab] = useState<ProviderId>('azure-devops');
  // Uma plataforma aberta por vez; sem nenhuma conectada, o Azure DevOps já começa aberto.
  const [open, setOpen] = useState<ProviderId | null | undefined>(undefined);
  const openRow = open === undefined ? (me.isFetched && connectedCount === 0 ? 'azure-devops' : null) : open;
  const [values, setValues] = useState<Record<FieldName, string>>({
    organization: defaultOrganization,
    owner: '',
    site: '',
    email: '',
  });

  // Com uma conexão ativa os campos começam na conta dela, para o "Trocar" partir do valor atual.
  const azure = accountOf('azure-devops')?.account;
  const github = accountOf('github')?.account;
  const jira = accountOf('jira')?.account;
  useEffect(() => {
    setValues((current) => ({
      ...current,
      organization: azure ?? current.organization,
      owner: github ?? current.owner,
      site: jira ?? current.site,
    }));
  }, [azure, github, jira]);

  const show = (provider: ProviderId | null) => {
    if (provider) setGuideTab(provider);
    setOpen(provider);
  };

  return (
      <main
        className={cx(
          'stroke flex w-full max-w-[82.5rem] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_0.75rem_2rem_#0F172A0F] lg:flex-row',
          ENTRY_CARD_HEIGHT,
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-5 px-10 py-7 short:gap-4 short:py-5">
          {/* Logo ao lado do título: a largura sobra, a altura não. */}
          <div className="flex items-center gap-5">
            <img src="/muralis-logo-full.png" alt="Muralis" className="h-[3.875rem] w-[6.875rem] shrink-0 object-contain" />
            <h1 className="min-w-0 text-2xl font-bold tracking-[-0.4px] text-ink">Release Management</h1>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold tracking-[0.6px] text-mute">{t('pat.platforms')}</span>
              <span className="text-[0.78125rem] text-mute">{t('pat.connectedCount', { count: connectedCount })}</span>
            </div>

            {PLATFORMS.map((platform) => {
              const account = accountOf(platform.id);
              const expanded = openRow === platform.id;
              return (
                <PlatformRow
                  key={platform.id}
                  logo={platform.logo(18)}
                  name={platform.name}
                  sub={account ? FORMS[platform.id].address(account.account ?? '') : t('pat.noToken')}
                  connected={!!account && !expanded}
                  expanded={expanded}
                  hint={expanded ? (connectedCount > 0 ? t('pat.close') : undefined) : account ? t('pat.change') : undefined}
                  onToggle={expanded ? (connectedCount > 0 ? () => show(null) : undefined) : () => show(platform.id)}
                >
                  <ConnectForm
                    provider={platform.id}
                    name={platform.name}
                    active={expanded}
                    values={values}
                    onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
                    onFocus={() => setGuideTab(platform.id)}
                    // Fica aberta, com o campo verde; fechar é com o usuário.
                    onConnected={() => setOpen(platform.id)}
                  />
                </PlatformRow>
              );
            })}
          </div>

          <div className="min-h-0 flex-1" />

          <div className="flex flex-col gap-2">
            <button
              type="button"
              disabled={!hasSource}
              onClick={() => navigate('/')}
              className={cx(
                'flex h-12 items-center justify-center gap-2 rounded-[0.625rem] text-[0.9375rem] font-semibold',
                hasSource ? 'hover-primary bg-ink text-white' : 'bg-[#E2E8F0] text-faint',
              )}
            >
              {t('pat.continue')}
              <ArrowRight size={rem(16)} />
            </button>
            <p className="text-center text-[0.78125rem] leading-[1.45] text-mute short:hidden">
              {t('pat.continueHint')}
            </p>
          </div>
        </div>

        <TokenGuide tab={guideTab} onTab={setGuideTab} organization={values.organization.trim()} />
      </main>
  );
}
