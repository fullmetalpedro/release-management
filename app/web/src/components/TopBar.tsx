import { useQueryClient } from '@tanstack/react-query';
import { Check, LogOut, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type Account, type Me, type ProviderId } from '../lib/api';
import { shortDate } from '../lib/format';
import { useSession } from '../lib/session';
import { AzureDevOpsLogo, GitHubLogo, JiraLogo } from './logos';
import { OrgMark } from './OrgMark';
import { useToast } from './toast';
import { Avatar, cx, Menu, MENU_ITEM_DARK, MenuContent, MenuItem, MenuTrigger } from './ui';
import { t } from '../lib/i18n';
import { rem } from '../lib/units';

const PROVIDERS: Record<ProviderId, { name: string; small: React.ReactNode }> = {
  'azure-devops': { name: 'Azure DevOps', small: <AzureDevOpsLogo size={12} /> },
  github: { name: 'GitHub', small: <GitHubLogo size={12} /> },
  jira: { name: 'Jira', small: <JiraLogo size={12} /> },
};

// Para onde vão "Conectar outra organização" e "Reconectar": a tela de token, já aberta na plataforma (e, ao
// reconectar, com a organização preenchida).
export interface ConnectIntent {
  provider: ProviderId;
  account?: string;
}

function AccountMenu({ me }: { me: Me }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = me.accounts.find((account) => account.active);
  const organizations = me.accounts.filter((account) => account.connected && account.provider !== 'jira').length;

  // Troca a organização que fornece os PRs; tudo que estava em cache era da anterior.
  const activate = async (account: Account) => {
    try {
      await api.setActiveConnection(account.id!);
      // A sessão é recarregada sem ser zerada (zerar desmontaria a tela); o resto recomeça do zero.
      await queryClient.refetchQueries({ queryKey: ['me'] });
      await queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== 'auth-mode' && query.queryKey[0] !== 'me' });
    } catch (error) {
      toast.show({ kind: 'error', title: t('account.switchFailed', { account: account.account }), description: (error as Error).message });
    }
  };

  const connect = (intent: ConnectIntent) => navigate('/login', { state: { connect: intent } });

  const logout = async () => {
    try {
      await api.logout();
    } catch (error) {
      // A sessão continua valendo no servidor: ir para a tela de entrada só traria o usuário de volta sem explicação.
      toast.show({ kind: 'error', title: t('account.logoutFailed'), description: (error as Error).message });
      return;
    }
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  const ROW = 'flex min-h-12 shrink-0 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left';
  const groups = (Object.keys(PROVIDERS) as ProviderId[]).map((provider) => ({
    provider,
    accounts: me.accounts.filter((account) => account.provider === provider),
  }));

  const orgRow = (account: Account) => {
    const expired = !!account.expiredAt;
    const switchable = me.mode === 'pat' && !account.active && !expired && account.provider !== 'jira';
    const name = account.account ?? (me.mode === 'pat' ? account.handle : me.organization) ?? PROVIDERS[account.provider].name;
    const content = (
      <>
        {account.provider !== 'jira' && <OrgMark name={name} muted={expired} />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cx('truncate text-[0.8125rem]', account.active ? 'font-semibold text-white' : expired ? 'font-medium text-[#8B919A]' : 'font-medium text-[#D1D5DB]')}>
            {name}
          </span>
          <span className="truncate text-xs text-[#8B919A]">
            {expired
              ? t('account.expiredOn', { date: shortDate(account.expiredAt) })
              : account.active
                ? t('account.activeShowing')
                : account.provider === 'jira'
                  ? t('account.connected')
                  : account.handle}
          </span>
        </div>
        {account.active && !expired && <Check size={rem(14)} className="shrink-0 text-white" />}
        {expired && (
          <span className="flex h-[1.625rem] shrink-0 items-center rounded-md bg-white px-2.5 text-xs font-semibold text-ink">
            {t('account.reconnect')}
          </span>
        )}
      </>
    );
    if (expired) {
      return (
        <MenuItem
          key={account.id}
          onSelect={() => connect({ provider: account.provider, account: account.account })}
          className={cx(ROW, MENU_ITEM_DARK)}
        >
          {content}
        </MenuItem>
      );
    }
    // A organização ativa (e o Jira, que não fornece PRs) só informa; as outras linhas trocam a ativa.
    if (!switchable) {
      return (
        <div key={account.id ?? account.provider} className={cx(ROW, account.active && account.provider !== 'jira' && 'bg-[#3A3F48]')}>
          {content}
        </div>
      );
    }
    return (
      <MenuItem
        key={account.id}
        title={t('account.showPrsFrom', { account: name })}
        onSelect={() => void activate(account)}
        className={cx(ROW, MENU_ITEM_DARK)}
      >
        {content}
      </MenuItem>
    );
  };

  // Plataforma sem nenhuma organização: um convite para conectar.
  const emptyRow = (provider: ProviderId) => (
    <MenuItem
      key={provider}
      onSelect={() => {
        // No modo token, conectar acontece na tela de plataformas.
        if (me.mode === 'pat') return connect({ provider });
        toast.show({
          kind: 'error',
          title: t('account.unavailable', { provider: PROVIDERS[provider].name }),
          description: t('account.unavailableBody'),
        });
      }}
      className={cx(ROW, MENU_ITEM_DARK)}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs text-[#6B7280]">{t('account.noAccount')}</span>
      </div>
      <span className="stroke flex h-[1.625rem] shrink-0 items-center rounded-md px-2.5 text-xs font-semibold text-[#D1D5DB] [--stroke:#4B515B]">
        {t('account.connect')}
      </span>
    </MenuItem>
  );

  return (
    <MenuContent tone="dark" align="end" width={340} offset={18} className="max-h-[min(40rem,var(--radix-dropdown-menu-content-available-height))]">
      <div className="flex items-center gap-3 px-2.5 pb-3 pt-2.5">
        <Avatar name={me.user.name} isMe avatarKey={me.user.avatarKey} size={36} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[0.8125rem] font-semibold text-white">{me.user.name}</span>
          <span className="text-xs text-[#8B919A]">
            {me.mode === 'pat'
              ? `${t('account.personalToken')} · ${t('account.organizations', { count: organizations })}`
              : t('account.viaMicrosoft')}
          </span>
        </div>
      </div>
      <div className="h-px shrink-0 bg-[#3A3F48]" />
      {groups.map(({ provider, accounts }) => {
        const connected = accounts.filter((account) => account.connected);
        return (
          <div key={provider} className="flex flex-col">
            <div className="flex items-center gap-2 px-2.5 pb-1.5 pt-2.5 text-[0.6875rem] font-semibold tracking-[0.6px] text-[#8B919A]">
              <span className="flex h-[1.125rem] w-[1.125rem] items-center justify-center rounded bg-white">{PROVIDERS[provider].small}</span>
              {provider === 'jira' ? t('account.jiraGroup') : PROVIDERS[provider].name.toUpperCase()}
            </div>
            {connected.length > 0 ? connected.map(orgRow) : emptyRow(provider)}
          </div>
        );
      })}
      <div className="mt-1.5 h-px shrink-0 bg-[#3A3F48]" />
      {me.mode === 'pat' && (
        <MenuItem
          onSelect={() => connect({ provider: active?.provider ?? 'azure-devops' })}
          className={cx('flex h-9 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left', MENU_ITEM_DARK)}
        >
          <Plus size={rem(16)} className="text-[#8B919A]" />
          <span className="text-[0.8125rem] font-medium text-[#D1D5DB]">{t('account.connectAnother')}</span>
        </MenuItem>
      )}
      <MenuItem onSelect={() => void logout()} className={cx('flex h-9 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left', MENU_ITEM_DARK)}>
        <LogOut size={rem(16)} className="text-[#8B919A]" />
        <span className="text-[0.8125rem] font-medium text-[#D1D5DB]">{t('account.signOut')}</span>
      </MenuItem>
    </MenuContent>
  );
}

export function TopBar() {
  const { me } = useSession();
  return (
    <header
      className="relative z-40 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-white px-8"
      // O cabeçalho é o mesmo nas duas telas, então fica parado enquanto o conteúdo troca com fade.
      style={{ viewTransitionName: 'top-bar' }}
    >
      <span className="whitespace-nowrap text-[1.3125rem] font-bold tracking-[-0.3px] text-ink">Release Management</span>
      <Menu>
        <MenuTrigger aria-label={t('account.menu')} className="rounded-full data-[state=open]:stroke-focus">
          <Avatar name={me.user.name} isMe avatarKey={me.user.avatarKey} size={30} />
        </MenuTrigger>
        <AccountMenu me={me} />
      </Menu>
    </header>
  );
}
