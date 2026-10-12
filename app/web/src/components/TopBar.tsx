import { useQueryClient } from '@tanstack/react-query';
import { Check, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type Me, type ProviderId } from '../lib/api';
import { useSession } from '../lib/session';
import { AzureDevOpsLogo, GitHubLogo, JiraLogo } from './logos';
import { useToast } from './toast';
import { Avatar, cx, Menu, MENU_ITEM_DARK, MenuContent, MenuItem, MenuTrigger } from './ui';
import { t } from '../lib/i18n';
import { rem } from '../lib/units';

const PROVIDERS: Record<ProviderId, { name: string; logo: React.ReactNode }> = {
  'azure-devops': { name: 'Azure DevOps', logo: <AzureDevOpsLogo size={16} /> },
  github: { name: 'GitHub', logo: <GitHubLogo size={16} /> },
  jira: { name: 'Jira', logo: <JiraLogo size={16} /> },
};

function AccountMenu({ me }: { me: Me }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = me.accounts.find((account) => account.active);

  // Troca a plataforma que fornece os PRs; tudo que estava em cache era da anterior.
  const activate = async (provider: ProviderId) => {
    try {
      await api.setActiveSource(provider);
      // A sessão é recarregada sem ser zerada (zerar desmontaria a tela); o resto recomeça do zero.
      await queryClient.refetchQueries({ queryKey: ['me'] });
      await queryClient.resetQueries({ predicate: (query) => query.queryKey[0] !== 'auth-mode' && query.queryKey[0] !== 'me' });
    } catch (error) {
      toast.show({ kind: 'error', title: t('account.switchFailed', { provider: PROVIDERS[provider].name }), description: (error as Error).message });
    }
  };

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

  const ROW = 'flex h-12 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left';
  return (
    <MenuContent tone="dark" align="end" width={320} offset={18}>
      <div className="flex items-center gap-3 px-2.5 pb-3 pt-2.5">
        <Avatar name={me.user.name} isMe avatarKey={me.user.avatarKey} size={36} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[0.8125rem] font-semibold text-white">{me.user.name}</span>
          <span className="text-xs text-[#8B919A]">
            {me.mode === 'pat' ? t('account.personalToken') : t('account.viaMicrosoft')}{active && me.mode === 'pat' ? ` · ${PROVIDERS[active.provider].name}` : ''}
          </span>
        </div>
      </div>
      <div className="h-px shrink-0 bg-[#3A3F48]" />
      <div className="px-2.5 pb-1.5 pt-2.5 text-[0.6875rem] font-semibold tracking-[0.6px] text-[#8B919A]">{t('account.accounts')}</div>
      {me.accounts.map((account) => {
        const provider = PROVIDERS[account.provider];
        const switchable = me.mode === 'pat' && account.connected && !account.active && account.provider !== 'jira';
        const content = (
          <>
            <span className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-[0.4375rem] bg-white', !account.connected && 'opacity-45')}>
              {provider.logo}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={cx(
                  'text-[0.8125rem]',
                  account.active ? 'font-semibold text-white' : account.connected ? 'font-medium text-[#D1D5DB]' : 'font-medium text-[#8B919A]',
                )}
              >
                {provider.name}
              </span>
              <span className={cx('truncate text-xs', account.connected ? 'text-[#8B919A]' : 'text-[#6B7280]')}>
                {account.connected ? account.handle : t('account.noAccount')}
              </span>
            </div>
            {account.active && <Check size={rem(14)} className="shrink-0 text-white" />}
            {!account.connected && (
              <span className="stroke flex h-[1.625rem] shrink-0 items-center rounded-md px-2.5 text-xs font-semibold text-[#D1D5DB] [--stroke:#4B515B]">
                {t('account.connect')}
              </span>
            )}
          </>
        );
        // A conta ativa (e o Jira, que não fornece PRs) só informa; as outras linhas são ações do menu.
        if (account.connected && !switchable) {
          return (
            <div key={account.provider} className={cx(ROW, account.active && 'bg-[#3A3F48]')}>
              {content}
            </div>
          );
        }
        return (
          <MenuItem
            key={account.provider}
            title={switchable ? t('account.showPrsFrom', { provider: provider.name }) : undefined}
            onSelect={() => {
              if (switchable) return void activate(account.provider);
              // No modo PAT, conectar e trocar tokens acontece na tela de plataformas.
              if (me.mode === 'pat') return navigate('/login');
              toast.show({
                kind: 'error',
                title: t('account.unavailable', { provider: provider.name }),
                description: t('account.unavailableBody'),
              });
            }}
            className={cx(ROW, MENU_ITEM_DARK)}
          >
            {content}
          </MenuItem>
        );
      })}
      <div className="h-px shrink-0 bg-[#3A3F48]" />
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
