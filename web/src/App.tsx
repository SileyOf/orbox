import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarCheck, Mail as MailIcon, Monitor, Moon, Settings as SettingsIcon, Sparkles, Sun } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api } from './api';
import type { Account, SiteInfo, Task, User } from './api';
import { applyAppearance, copyText, dismissToast, toast, useToasts } from './lib';
import { Assistant } from './components/Assistant';
import { Admin } from './pages/Admin';
import { Login } from './pages/Login';
import { MailPage } from './pages/Mail';
import { Planner } from './pages/Planner';
import { Settings } from './pages/Settings';

const UserContext = createContext<User>(null!);
export const useUser = () => useContext(UserContext);

/** 站点外观（名称、Logo 等），登录前后都需要 */
export function useSite(): SiteInfo | undefined {
  const status = useQuery({ queryKey: ['auth-status'], queryFn: () => api<{ site: SiteInfo }>('/auth/status'), staleTime: 5 * 60_000 });
  const site = status.data?.site;
  useEffect(() => {
    if (!site) return;
    document.title = site.name;
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) icon.href = site.hasLogo ? '/api/site/logo' : '/logo.svg';
  }, [site?.name, site?.hasLogo]);
  return site;
}

export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => api<Account[]>('/accounts') });
export const useTasks = (status: 'open' | 'done' = 'open') =>
  useQuery({ queryKey: ['tasks', status], queryFn: () => api<Task[]>(`/tasks?status=${status}`) });

export function useSaveSettings() {
  const qc = useQueryClient();
  return async (patch: Record<string, unknown>) => {
    const user = await api<User>('/me', { method: 'PATCH', body: patch });
    qc.setQueryData(['me'], user);
    return user;
  };
}

function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" role="status">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span>{t.text}</span>
          {t.action && (
            <button
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** 订阅服务端事件：数据有变就让对应查询失效，提醒和新邮件弹提示 */
function useServerEvents() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    const es = new EventSource('/api/events');
    const desktop = (title: string, body: string) => {
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/logo.svg' });
      }
    };
    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);
      if (ev.type === 'mail') {
        qc.invalidateQueries({ queryKey: ['messages'] });
        qc.invalidateQueries({ queryKey: ['accounts'] });
      } else if (ev.type === 'accounts') {
        qc.invalidateQueries({ queryKey: ['accounts'] });
      } else if (ev.type === 'tasks') {
        qc.invalidateQueries({ queryKey: ['tasks'] });
      } else if (ev.type === 'reminder') {
        toast(`⏰ ${ev.title}`, { ms: 12_000, action: { label: '查看', run: () => navigate('/planner') } });
        desktop('计划提醒', ev.title);
      } else if (ev.type === 'outbox') {
        qc.invalidateQueries({ queryKey: ['outbox'] });
      } else if (ev.type === 'new-mail' && ev.code) {
        // 验证码邮件：提示里直接给出验证码，一点即复制
        toast(`🔑 ${ev.code} · ${ev.from}`, { ms: 30_000, action: { label: '复制', run: () => copyText(ev.code) } });
        desktop(`验证码 ${ev.code}`, `${ev.from} · ${ev.subject}`);
      } else if (ev.type === 'new-mail') {
        toast(`${ev.from}：${ev.subject || '(无主题)'}`, {
          ms: 8000,
          action: { label: '打开', run: () => navigate(`/mail?open=${ev.id}`) },
        });
        desktop(ev.from, ev.subject);
      }
    };
    return () => es.close();
  }, [qc, navigate]);
}

function Shell({ user }: { user: User }) {
  useServerEvents();
  const save = useSaveSettings();
  const { data: accounts } = useAccounts();
  const { data: tasks } = useTasks();
  const unread = (accounts || []).flatMap((a) => a.folders).filter((f) => f.role === 'inbox').reduce((n, f) => n + f.unread, 0);
  const dueNow = (tasks || []).filter((t) => t.due_at && new Date(t.due_at).getTime() <= Date.now()).length;

  const [assistant, setAssistant] = useState(false);
  const site = useSite();
  const location = useLocation();
  const { theme } = user.settings;
  const nextTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon;
  const link = ({ isActive }: { isActive: boolean }) => `rail-btn${isActive ? ' active' : ''}`;

  return (
    <div className="app">
      <nav className="rail">
        <img className="rail-logo" src={site?.hasLogo ? '/api/site/logo' : '/logo.svg'} alt={site?.name} title={site?.name} />
        <NavLink to="/mail" className={link} title="邮件">
          <MailIcon size={20} />
          {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
        <NavLink to="/planner" className={link} title="计划">
          <CalendarCheck size={20} />
          {dueNow > 0 && <span className="badge">{dueNow}</span>}
        </NavLink>
        <button className={`rail-btn${assistant ? ' active' : ''}`} title="助手" onClick={() => setAssistant(!assistant)}>
          <Sparkles size={20} />
        </button>
        <div className="rail-spacer" />
        <button
          className="rail-btn"
          title={`主题：${{ system: '跟随系统', light: '浅色', dark: '深色' }[theme]}`}
          onClick={() => save({ settings: { theme: nextTheme } })}
        >
          <ThemeIcon size={19} />
        </button>
        <NavLink to="/settings/mailboxes" className={() => link({ isActive: location.pathname.startsWith('/settings') || (!!user.adminPath && location.pathname.startsWith(`/${user.adminPath}`)) })} title="设置">
          <SettingsIcon size={20} />
        </NavLink>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/mail" element={<MailPage />} />
          <Route path="/planner" element={<Planner />} />
          <Route path="/settings/:section?" element={<Settings />} />
          {user.adminPath && <Route path={`/${user.adminPath}/:section?`} element={<Admin />} />}
          <Route path="*" element={<Navigate to="/mail" replace />} />
        </Routes>
      </main>
      {assistant && <Assistant onClose={() => setAssistant(false)} />}
    </div>
  );
}

export function App() {
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<User>('/me').catch((e) => (e instanceof ApiError && e.status === 401 ? null : Promise.reject(e))),
    staleTime: Infinity,
  });
  const user = me.data;

  useEffect(() => {
    if (!user) return;
    applyAppearance(user.settings);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyAppearance(user.settings);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [user]);

  if (me.isLoading) return <div className="empty" style={{ height: '100dvh' }}>正在加载…</div>;
  return (
    <>
      {user ? (
        <UserContext.Provider value={user}>
          <Shell user={user} />
        </UserContext.Provider>
      ) : me.isError ? (
        <div className="empty">
          无法连接服务器
          <button className="btn" onClick={() => me.refetch()}>
            重试
          </button>
        </div>
      ) : (
        <Login />
      )}
      <Toasts />
    </>
  );
}
