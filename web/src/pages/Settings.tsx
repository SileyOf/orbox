import { Bell, Bot, Mail, Palette, PlugZap, Shield, User } from 'lucide-react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { useUser } from '../App';
import { AccountPage } from './settings/Account';
import { AiPage } from './settings/Ai';
import { AppearancePage } from './settings/Appearance';
import { ConnectPage } from './settings/Connect';
import { MailboxesPage } from './settings/Mailboxes';
import { NotifyPage } from './settings/Notify';

const SECTIONS = [
  { id: 'mailboxes', label: '邮箱', icon: Mail, page: MailboxesPage },
  { id: 'notify', label: '通知渠道', icon: Bell, page: NotifyPage },
  { id: 'ai', label: 'AI', icon: Bot, page: AiPage },
  { id: 'connect', label: 'AI 连接（MCP）', icon: PlugZap, page: ConnectPage },
  { id: 'appearance', label: '外观', icon: Palette, page: AppearancePage },
  { id: 'account', label: '账户', icon: User, page: AccountPage },
];

export function Settings() {
  const user = useUser();
  const { section } = useParams();
  const current = SECTIONS.find((s) => s.id === section);
  if (!current) return <Navigate to="/settings/mailboxes" replace />;
  const Page = current.page;
  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        <h1>设置</h1>
        {SECTIONS.map((s) => (
          <NavLink key={s.id} to={`/settings/${s.id}`} className={({ isActive }) => `side-item${isActive ? ' active' : ''}`}>
            <s.icon size={16} />
            {s.label}
          </NavLink>
        ))}
        {user.adminPath && (
          <NavLink to={`/${user.adminPath}`} className="side-item admin-link">
            <Shield size={16} />
            后台管理
          </NavLink>
        )}
      </nav>
      <div className="settings">
        <div className="settings-inner">
          <Page />
        </div>
      </div>
    </div>
  );
}
