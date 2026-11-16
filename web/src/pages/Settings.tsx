import { Bell, Bot, Mail, Shield, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { NavLink, Navigate, useParams } from 'react-router-dom';
import { useUser } from '../App';
import { AiPage } from './settings/Ai';
import { GeneralPage } from './settings/General';
import { MailboxesPage } from './settings/Mailboxes';
import { NotifyPage } from './settings/Notify';
import { SecurityPage } from './settings/Security';

const SECTIONS = [
  { id: 'mailboxes', label: '邮箱', icon: Mail, page: MailboxesPage },
  { id: 'notify', label: '通知', icon: Bell, page: NotifyPage },
  { id: 'ai', label: 'AI', icon: Bot, page: AiPage },
  { id: 'security', label: '安全', icon: ShieldCheck, page: SecurityPage },
  { id: 'general', label: '通用', icon: SlidersHorizontal, page: GeneralPage },
];
/** 旧版本的地址（书签、文档里的链接）转到合并后的页面 */
const MOVED: Record<string, string> = { connect: 'ai', appearance: 'general', account: 'general' };

export function Settings() {
  const user = useUser();
  const { section } = useParams();
  const current = SECTIONS.find((s) => s.id === section);
  if (!current) return <Navigate to={`/settings/${MOVED[section || ''] || 'mailboxes'}${location.search}`} replace />;
  const Page = current.page;
  return (
    <div className="settings-layout">
      <nav className="settings-nav">
        <h1>设置</h1>
        {SECTIONS.map((s) => (
          <NavLink key={s.id} to={`/settings/${s.id}`} className={({ isActive }) => `side-item${isActive ? ' active' : ''}`}>
            <s.icon size={16} />
            {s.label}
            {s.id === 'security' && !user.twoFactor && <span className="nav-dot" title="还没有开启两步验证" />}
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
