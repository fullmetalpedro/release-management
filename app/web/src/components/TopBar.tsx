import { useQueryClient } from '@tanstack/react-query';
import { Check, LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api, type Me, type ProviderId } from '../lib/api';
import { useSession } from '../lib/session';
import { AzureDevOpsLogo, GitHubLogo, JiraLogo } from './logos';
import { useToast } from './toast';
import { Avatar, cx, useDropdown } from './ui';
import { t } from '../lib/i18n';

const PROVIDERS: Record<ProviderId, { name: string; logo: React.ReactNode }> = {
  'azure-devops': { name: 'Azure DevOps', logo: <AzureDevOpsLogo size={16} /> },
  github: { name: 'GitHub', logo: <GitHubLogo size={16} /> },
  jira: { name: 'Jira', logo: <JiraLogo size={16} /> },
};

function AccountDropdown({ me, onClose }: { me: Me; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const active = me.accounts.find((account) => account.active);

  // Troca a plataforma que fornece os PRs; tudo que estava em cache era da anterior.
  const activate = async (provider: ProviderId) => {
    onClose();
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

  return (
    <div
      role="menu"
      className="pop-in absolute right-0 top-full z-40 mt-[19px] flex w-80 flex-col gap-0.5 rounded-[10px] bg-[#2A2D33] p-1.5 shadow-[0_10px_28px_#0F172A40]"
    >
      <div className="flex items-center gap-3 px-2.5 pb-3 pt-2.5">
        <Avatar name={me.user.name} isMe avatarKey={me.user.avatarKey} size={36} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13px] font-semibold text-white">{me.user.name}</span>
          <span className="text-xs text-[#8B919A]">
            {me.mode === 'pat' ? t('account.personalToken') : t('account.viaMicrosoft')}{active && me.mode === 'pat' ? ` · ${PROVIDERS[active.provider].name}` : ''}
          </span>
        </div>
      </div>
      <div className="h-px bg-[#3A3F48]" />
      <div className="px-2.5 pb-1.5 pt-2.5 text-[11px] font-semibold tracking-[0.6px] text-[#8B919A]">{t('account.accounts')}</div>
      {me.accounts.map((account) => {
        const provider = PROVIDERS[account.provider];
        const switchable = me.mode === 'pat' && account.connected && !account.active && account.provider !== 'jira';
        const Row = switchable ? 'button' : 'div';
        return (
          <Row
            key={account.provider}
            {...(switchable
              ? { type: 'button', role: 'menuitem', title: t('account.showPrsFrom', { provider: provider.name }), onClick: () => void activate(account.provider) }
              : {})}
            className={cx(
              'flex h-12 items-center gap-2.5 rounded-md px-2.5 text-left',
              account.active && 'bg-[#3A3F48]',
              switchable && 'hover-dark',
            )}
          >
            <span
              className={cx(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-white',
                !account.connected && 'opacity-45',
              )}
            >
              {provider.logo}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className={cx(
                  'text-[13px]',
                  account.active
                    ? 'font-semibold text-white'
                    : account.connected
                      ? 'font-medium text-[#D1D5DB]'
                      : 'font-medium text-[#8B919A]',
                )}
              >
                {provider.name}
              </span>
              <span className={cx('truncate text-xs', account.connected ? 'text-[#8B919A]' : 'text-[#6B7280]')}>
                {account.connected ? account.handle : t('account.noAccount')}
              </span>
            </div>
            {account.active && <Check size={14} className="shrink-0 text-white" />}
            {!account.connected && (
              <button
                type="button"
                className="stroke flex h-[26px] shrink-0 items-center rounded-md px-2.5 text-xs font-semibold text-[#D1D5DB] [--stroke:#4B515B] hover-dark"
                onClick={() => {
                  onClose();
                  // No modo PAT, conectar e trocar tokens acontece na tela de plataformas.
                  if (me.mode === 'pat') return navigate('/login');
                  toast.show({
                    kind: 'error',
                    title: t('account.unavailable', { provider: provider.name }),
                    description: t('account.unavailableBody'),
                  });
                }}
              >
                {t('account.connect')}
              </button>
            )}
          </Row>
        );
      })}
      <div className="h-px bg-[#3A3F48]" />
      <button
        type="button"
        role="menuitem"
        onClick={logout}
        className="hover-dark flex h-9 items-center gap-2.5 rounded-md px-2.5 text-left"
      >
        <LogOut size={16} className="text-[#8B919A]" />
        <span className="text-[13px] font-medium text-[#D1D5DB]">{t('account.signOut')}</span>
      </button>
    </div>
  );
}

export function TopBar() {
  const { me } = useSession();
  const { open, setOpen, ref } = useDropdown();
  return (
    <header
      className="relative z-40 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-white px-8"
      // O cabeçalho é o mesmo nas duas telas, então fica parado enquanto o conteúdo troca com fade.
      style={{ viewTransitionName: 'top-bar' }}
    >
      <span className="whitespace-nowrap text-[21px] font-bold tracking-[-0.3px] text-ink">Release Management</span>
      <div ref={ref} className="relative flex items-center">
        <button
          type="button"
          aria-label={t('account.menu')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cx('rounded-full', open && 'stroke-focus')}
        >
          <Avatar name={me.user.name} isMe avatarKey={me.user.avatarKey} size={30} />
        </button>
        {open && <AccountDropdown me={me} onClose={() => setOpen(false)} />}
      </div>
    </header>
  );
}
