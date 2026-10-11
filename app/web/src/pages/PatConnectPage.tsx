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

interface Guide {
  title: string;
  description: string;
  link: (organization: string) => { label: string; href: string };
  steps: [string, string, string, string, string];
  scopes: { name: string; level: string; description: string; mono?: boolean }[];
  note: string;
}

// Azure DevOps sempre primeiro, em todos os seletores do sistema.
const PLATFORMS: { id: ProviderId; name: string; logo: (size: number) => ReactNode }[] = [
  { id: 'azure-devops', name: 'Azure DevOps', logo: (size) => <AzureDevOpsLogo size={size} /> },
  { id: 'github', name: 'GitHub', logo: (size) => <GitHubLogo size={size} /> },
  { id: 'jira', name: 'Jira', logo: (size) => <JiraLogo size={size} /> },
];

const GUIDES: Record<ProviderId, Guide> = {
  'azure-devops': {
    title: 'Token do Azure DevOps',
    description:
      'O token vale para uma organização só. Para trocar de organização, gere um novo token nela e conecte no lugar do atual.',
    link: (organization) => ({
      label: `dev.azure.com/${organization || '{org}'}/_usersSettings/tokens`,
      href: organization
        ? `https://dev.azure.com/${encodeURIComponent(organization)}/_usersSettings/tokens`
        : 'https://dev.azure.com',
    }),
    steps: [
      'Abra a página de tokens da organização no Azure DevOps.',
      'Clique em New Token e, em Organization, escolha a organização que você quer usar. Não use All accessible organizations.',
      'Defina a validade. A política da organização pode limitar o prazo máximo.',
      'Em Scopes, escolha Custom defined e marque:',
      'Copie o token e cole no campo do Azure DevOps, junto com o nome da organização. Ele só aparece uma vez.',
    ],
    scopes: [
      { name: 'Code', level: 'Read & Write', description: 'Ler PRs e criar a branch de release' },
      { name: 'Work Items', level: 'Read & Write', description: 'Ler e vincular work items aos PRs' },
      { name: 'Project and Team', level: 'Read', description: 'Listar os projetos da organização' },
    ],
    note: 'O token só faz o que a sua conta já pode fazer. Para criar releases, você ainda precisa das permissões Contribute e Create branch no repositório.',
  },
  jira: {
    title: 'Token do Jira',
    description:
      'Use um API token com escopos da sua conta Atlassian. O site informado define qual Jira será usado; para trocar de site, conecte outro token.',
    link: () => ({
      label: 'id.atlassian.com/manage-profile/security/api-tokens',
      href: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    }),
    steps: [
      'Abra a página de API tokens da sua conta Atlassian.',
      'Clique em Create API token with scopes, dê um nome e defina a validade (até 1 ano).',
      'Em Select app, escolha Jira.',
      'Marque os escopos abaixo e crie o token:',
      'Copie o token e cole no campo do Jira, junto com o e-mail da conta e o site (ex.: muralis.atlassian.net). Ele só aparece uma vez.',
    ],
    scopes: [
      { name: 'read:jira-work', level: 'Read', description: 'Ler e buscar as issues vinculadas aos PRs', mono: true },
      { name: 'write:jira-work', level: 'Write', description: 'Vincular e desvincular PRs nas issues', mono: true },
      { name: 'read:jira-user', level: 'Read', description: 'Identificar a sua conta', mono: true },
    ],
    note: 'O token só faz o que a sua conta já pode fazer. Para vincular PRs, você precisa poder editar as issues do projeto.',
  },
  github: {
    title: 'Token do GitHub',
    description:
      'Use um fine-grained token. Ele vale para um dono só; para trocar de organização, gere outro token nela e conecte no lugar do atual.',
    link: () => ({
      label: 'github.com/settings/personal-access-tokens/new',
      href: 'https://github.com/settings/personal-access-tokens/new',
    }),
    steps: [
      'Abra a página de criação de fine-grained tokens.',
      'Em Resource owner, escolha a organização e defina a validade.',
      'Em Repository access, escolha All repositories ou só os repositórios que você vai usar.',
      'Em Permissions › Repository permissions, marque:',
      'Gere o token e cole no campo do GitHub. Se a organização exigir aprovação, o token só funciona depois que um owner aprovar.',
    ],
    scopes: [
      { name: 'Contents', level: 'Read & Write', description: 'Ler commits e criar a branch de release' },
      { name: 'Pull requests', level: 'Read', description: 'Ler PRs, revisões e comentários' },
      { name: 'Metadata', level: 'Read', description: 'Obrigatória, o GitHub marca sozinho' },
    ],
    note: 'O token só faz o que a sua conta já pode fazer. Para criar releases, você precisa de permissão Write nos repositórios.',
  },
};

function GuideStep({ number, text, children }: { number: number; text: string; children?: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="stroke flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-white text-[11.5px] font-bold text-ink-2 [--stroke:#CBD5E1]">
        {number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2.5 pt-0.5">
        <p className="text-[13.5px] leading-[1.5] text-ink-2">{text}</p>
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
  const guide = GUIDES[shown];
  const link = guide.link(organization);
  return (
    <aside className="flex w-full shrink-0 flex-col gap-5 border-t border-line bg-canvas px-9 py-7 short:py-5 lg:w-[680px] lg:border-l lg:border-t-0">
      <div role="tablist" aria-label="Guia do token" className="flex gap-[3px] rounded-[10px] bg-[#EEF0F3] p-[3px]">
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
                'flex h-8 flex-1 basis-0 items-center justify-center gap-1.5 rounded-lg text-[12.5px]',
                selected ? 'bg-white font-semibold text-ink shadow-[0_1px_3px_#0F172A14]' : 'font-medium text-mute hover:text-ink',
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
        <p className="text-[13.5px] leading-[1.5] text-mute">{guide.description}</p>
      </div>

      {/* Passos 1 a 3 numa coluna, 4 e 5 na outra: o guia usa a largura em vez de empilhar tudo. */}
      <div className="grid grid-cols-1 gap-x-7 gap-y-[18px] md:grid-cols-2">
      <ol className="flex flex-col gap-[18px]">
        <GuideStep number={1} text={guide.steps[0]}>
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="stroke flex max-w-full items-center gap-1.5 rounded-md bg-white px-2.5 py-1.5 hover-surface"
          >
            <span className="min-w-0 break-all font-mono text-[11.5px] font-medium leading-[1.4] text-[#1E40AF]">{link.label}</span>
            <ExternalLink size={12} className="shrink-0 text-[#1E40AF]" />
          </a>
        </GuideStep>
        <GuideStep number={2} text={guide.steps[1]} />
        <GuideStep number={3} text={guide.steps[2]} />
      </ol>
      <ol start={4} className="flex flex-col gap-[18px]">
        <GuideStep number={4} text={guide.steps[3]}>
          <ul className="stroke flex w-full flex-col rounded-[10px] bg-white">
            {guide.scopes.map((scope, index) => (
              <li
                key={scope.name}
                className={cx('flex gap-2.5 px-3 py-[9px]', index < guide.scopes.length - 1 && 'border-b border-line-soft')}
              >
                <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-ink">
                  <Check size={12} className="text-white" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cx('text-[13px] font-semibold text-ink', scope.mono && 'font-mono text-[12.5px]')}>{scope.name}</span>
                    <span
                      className={cx(
                        'whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold',
                        scope.level === 'Read' ? 'bg-[#F1F5F9] text-ink-2' : 'bg-[#DBEAFE] text-[#1E40AF]',
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

      <div className="stroke flex gap-2.5 rounded-[10px] bg-[#FFFBEB] px-3.5 py-3 [--stroke:#FDE68A]">
        <Info size={16} className="shrink-0 text-[#B45309]" />
        <p className="text-[12.5px] leading-[1.45] text-[#92400E]">{guide.note}</p>
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
          <span className="text-[15px] font-semibold text-ink">{name}</span>
          <span className="truncate text-[12.5px] text-mute">{sub}</span>
        </div>
        {connected && (
          <span className="flex items-center gap-[5px] rounded-full bg-[#DCFCE7] py-[3px] pl-[7px] pr-[9px]">
            <CircleCheck size={12} className="text-[#166534]" />
            <span className="text-xs font-semibold text-[#166534]">Conectado</span>
          </span>
        )}
        {hint && <span className="text-[13px] font-semibold text-mute">{hint}</span>}
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
export const ENTRY_CARD_HEIGHT = 'lg:h-[702px] lg:short:h-[648px]';

const EMAIL = /^S+@S+.S+$/;

type FieldName = 'organization' | 'owner' | 'site' | 'email';

interface FormSpec {
  fields: { name: FieldName; label: string; prefix?: string; placeholder?: string; autoComplete?: string }[];
  tokenLabel: string;
  hint: string;
  account: (values: Record<FieldName, string>) => PlatformAccount;
  // Endereço da conta conectada, mostrado na linha da plataforma.
  address: (account: string) => string;
}

const FORMS: Record<ProviderId, FormSpec> = {
  'azure-devops': {
    fields: [{ name: 'organization', label: 'Organização', prefix: 'dev.azure.com/', autoComplete: 'organization' }],
    tokenLabel: 'Personal Access Token',
    hint: 'Para usar outra organização, gere um token nela e conecte no lugar deste.',
    account: (values) => ({ organization: values.organization.trim() }),
    address: (account) => `dev.azure.com/${account}`,
  },
  github: {
    fields: [{ name: 'owner', label: 'Organização ou usuário', prefix: 'github.com/', autoComplete: 'organization' }],
    tokenLabel: 'Fine-grained token',
    hint: 'Com o GitHub ativo, as tasks vêm do Jira, se ele estiver conectado.',
    account: (values) => ({ organization: values.owner.trim() }),
    address: (account) => `github.com/${account}`,
  },
  jira: {
    fields: [
      { name: 'site', label: 'Site', placeholder: 'empresa.atlassian.net', autoComplete: 'url' },
      { name: 'email', label: 'E-mail da conta', placeholder: 'voce@empresa.com', autoComplete: 'email' },
    ],
    tokenLabel: 'API token',
    hint: 'O Jira fornece as tasks dos PRs do GitHub. Os PRs do Azure DevOps usam os work items de lá.',
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
        title: `${name} conectado em ${result.account}`,
        description: `Token validado para ${result.user.name}.`,
      });
    },
  });

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
              <label htmlFor={`pat-${field.name}`} className="text-[12.5px] font-medium text-ink-2">
                {field.label}
              </label>
              <div className="stroke flex h-10 items-center rounded-lg bg-white px-3 [--stroke:#CBD5E1] focus-within:[--stroke:#0F172A]">
                {field.prefix && <span className="font-mono text-[13px] text-faint">{field.prefix}</span>}
                <input
                  id={`pat-${field.name}`}
                  value={values[field.name]}
                  onChange={(event) => onChange(field.name, event.target.value)}
                  onFocus={onFocus}
                  placeholder={field.placeholder}
                  autoComplete={field.autoComplete}
                  spellCheck={false}
                  className="min-w-0 flex-1 bg-transparent font-mono text-[13px] font-medium text-ink outline-none placeholder:font-normal placeholder:text-faint"
                />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`pat-token-${provider}`} className="text-[12.5px] font-medium text-ink-2">
            {spec.tokenLabel}
          </label>
          <div
            className={cx(
              'stroke flex h-10 items-center gap-2 rounded-lg px-3',
              validated
                ? 'bg-[#F0FDF4] [--stroke:#16A34A]'
                : connect.isError
                  ? 'bg-white [--stroke:#DC2626]'
                  : 'bg-white [--stroke:#CBD5E1] focus-within:[--stroke:#0F172A]',
            )}
          >
            <KeyRound size={15} className={cx('shrink-0', validated ? 'text-[#16A34A]' : 'text-mute')} />
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
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] leading-[1.2] text-ink outline-none"
            />
            {!pending && (
              <button
                type="button"
                aria-label={reveal ? 'Ocultar token' : 'Mostrar token'}
                aria-pressed={reveal}
                onClick={() => setReveal(!reveal)}
                className="shrink-0 text-faint hover:text-ink-2"
              >
                {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            )}
            {pending && (
              <LoaderCircle size={16} role="status" aria-label="Validando o token" className="shrink-0 animate-spin text-mute" />
            )}
            {validated && !pending && (
              <CircleCheck size={16} role="img" aria-label="Token validado" className="shrink-0 text-[#16A34A]" />
            )}
          </div>
          {connect.isError && (
            <p id={errorId} role="alert" className="text-[12.5px] leading-[1.4] text-[#B91C1C]">
              {connect.error.message}
            </p>
          )}
        </div>
      </div>
      <div className="flex gap-2">
        <Repeat2 size={14} className="mt-0.5 shrink-0 text-mute" />
        <p className="text-[12.5px] leading-[1.4] text-mute">{spec.hint}</p>
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
          'stroke flex w-full max-w-[1320px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_12px_32px_#0F172A0F] lg:flex-row',
          ENTRY_CARD_HEIGHT,
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-5 px-10 py-7 short:gap-4 short:py-5">
          {/* Logo ao lado do título: a largura sobra, a altura não. */}
          <div className="flex items-center gap-5">
            <img src="/muralis-logo-full.png" alt="Muralis" className="h-[62px] w-[110px] shrink-0 object-contain" />
            <h1 className="min-w-0 text-2xl font-bold tracking-[-0.4px] text-ink">Release Management</h1>
          </div>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold tracking-[0.6px] text-mute">PLATAFORMAS</span>
              <span className="text-[12.5px] text-mute">{connectedCount} de 3 conectadas</span>
            </div>

            {PLATFORMS.map((platform) => {
              const account = accountOf(platform.id);
              const expanded = openRow === platform.id;
              return (
                <PlatformRow
                  key={platform.id}
                  logo={platform.logo(18)}
                  name={platform.name}
                  sub={account ? FORMS[platform.id].address(account.account ?? '') : 'Nenhum token conectado'}
                  connected={!!account && !expanded}
                  expanded={expanded}
                  hint={expanded ? (connectedCount > 0 ? 'Fechar' : undefined) : account ? 'Trocar' : undefined}
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
                'flex h-12 items-center justify-center gap-2 rounded-[10px] text-[15px] font-semibold',
                hasSource ? 'hover-primary bg-ink text-white' : 'bg-[#E2E8F0] text-faint',
              )}
            >
              Continuar
              <ArrowRight size={16} />
            </button>
            <p className="text-center text-[12.5px] leading-[1.45] text-mute short:hidden">
              Conecte o Azure DevOps ou o GitHub para continuar.
            </p>
          </div>
        </div>

        <TokenGuide tab={guideTab} onTab={setGuideTab} organization={values.organization.trim()} />
      </main>
  );
}
