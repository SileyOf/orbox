import { useQuery } from '@tanstack/react-query';
import { Bell, Copy, Send } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSaveSettings, useUser } from '../../App';
import { api } from '../../api';
import type { EventKind, UserSettings } from '../../api';
import { copyText, toast, toastError } from '../../lib';
import { Section, SenderRule, Setting, Switch } from './ui';

const EVENTS: { kind: EventKind; label: string }[] = [
  { kind: 'mail', label: '新邮件' },
  { kind: 'code', label: '验证码' },
  { kind: 'task', label: '计划提醒' },
  { kind: 'digest', label: '早报' },
  { kind: 'snooze', label: '稍后处理' },
];

interface BotsInfo {
  platforms: { platform: string; label: string; enabled: boolean; name: string | null }[];
  links: { platform: string; username: string }[];
}

/** 每个渠道一行：状态、操作，以及它接收哪些事件 */
function ChannelRow(props: { id: string; title: string; status: ReactNode; actions?: ReactNode; children?: ReactNode; active: boolean }) {
  const user = useUser();
  const save = useSaveSettings();
  const routing = user.settings.routing || {};
  const on = (kind: EventKind) => routing[props.id]?.[kind] !== false;
  const toggle = (kind: EventKind) =>
    save({ settings: { routing: { ...routing, [props.id]: { ...routing[props.id], [kind]: !on(kind) } } } }).catch(toastError);
  return (
    <div className="channel">
      <div className="row">
        <div className="grow" style={{ minWidth: 0 }}>
          <div>{props.title}</div>
          <div className="muted small">{props.status}</div>
        </div>
        {props.actions}
      </div>
      {props.children}
      {props.active && (
        <div className="event-chips">
          {EVENTS.map((e) => (
            <button key={e.kind} className={`chip${on(e.kind) ? ' accent' : ''}`} onClick={() => toggle(e.kind)} title={on(e.kind) ? '点击后不再接收' : '点击后开始接收'}>
              {e.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PushUrl(props: { name: 'bark' | 'ntfy' | 'webhook'; placeholder: string }) {
  const user = useUser();
  const save = useSaveSettings();
  const value = user.settings.channels[props.name];
  const [url, setUrl] = useState(value);
  const commit = () => url.trim() !== value && save({ settings: { channels: { ...user.settings.channels, [props.name]: url.trim() } } }).catch(toastError);
  return (
    <div className="row" style={{ marginTop: 8 }}>
      <input className="input grow" placeholder={props.placeholder} value={url} onChange={(e) => setUrl(e.target.value)} onBlur={commit} />
      <button
        className="btn sm"
        disabled={!url.trim()}
        onClick={() => api('/notify/test', { body: { channel: props.name, target: url.trim() } }).then(() => toast('已发送测试通知')).catch(toastError)}
      >
        测试
      </button>
    </div>
  );
}

export function NotifyPage() {
  const user = useUser();
  const save = useSaveSettings();
  const s = user.settings;
  const set = (patch: Partial<UserSettings>) => save({ settings: patch }).catch(toastError);
  const bots = useQuery({ queryKey: ['bots'], queryFn: () => api<BotsInfo>('/bots') });
  const ai = useQuery({ queryKey: ['ai'], queryFn: () => api<{ active: Record<string, boolean> }>('/ai') });
  const [bind, setBind] = useState<{ code: string; hints: { platform: string; label: string; url?: string; text: string }[] } | null>(null);

  async function startBind() {
    try {
      setBind(await api('/bots/code', { method: 'POST' }));
    } catch (e) {
      toastError(e);
    }
  }

  const enabledBots = (bots.data?.platforms || []).filter((p) => p.enabled);

  return (
    <>
      <Section
        title="通知渠道"
        hint={user.perms.bots ? '每个渠道可以单独选择接收哪些事件（点亮的会推送）。聊天机器人可以直接阅读全文、处理邮件和计划；推送通道只能单向通知。' : '管理员没有给你开放聊天机器人，只能使用下面的推送通道。'}
        action={
          bots.data?.links.length ? (
            <button className="btn sm" onClick={() => api('/bots/test', { body: {} }).then(() => toast('已发送')).catch(toastError)}>
              <Send size={14} /> 测试机器人
            </button>
          ) : null
        }
      >
        <div className="card">
          {(bots.data?.platforms || []).map((p) => {
            const link = bots.data!.links.find((l) => l.platform === p.platform);
            return (
              <ChannelRow
                key={p.platform}
                id={p.platform}
                title={p.label}
                active={!!link}
                status={
                  !p.enabled
                    ? user.adminPath
                      ? <>还没有配置机器人，<Link to={`/${user.adminPath}/integrations`}>去后台配置</Link></>
                      : '管理员还没有启用这个平台'
                    : !p.name
                      ? '正在连接…'
                      : link
                        ? `已绑定${link.username ? ` ${link.username}` : ''} · 机器人 ${p.name}`
                        : `未绑定 · 机器人 ${p.name}`
                }
                actions={
                  link ? (
                    <button className="btn sm danger" onClick={() => api(`/bots/${p.platform}`, { method: 'DELETE' }).then(() => bots.refetch())}>解绑</button>
                  ) : p.enabled && p.name ? (
                    <button className="btn sm accent" onClick={startBind}>绑定</button>
                  ) : null
                }
              />
            );
          })}
          <ChannelRow id="bark" title="Bark（iOS）" active={!!s.channels.bark} status="推送到 iPhone，验证码会自动进入剪贴板">
            <PushUrl name="bark" placeholder="https://api.day.app/你的Key" />
          </ChannelRow>
          <ChannelRow id="ntfy" title="ntfy" active={!!s.channels.ntfy} status="填完整的主题地址，支持自建服务器">
            <PushUrl name="ntfy" placeholder="https://ntfy.sh/你的主题" />
          </ChannelRow>
          <ChannelRow id="webhook" title="Webhook" active={!!s.channels.webhook} status="每条通知以 JSON POST 到这个地址（title、body、text、url、code），可接企业微信、钉钉等">
            <PushUrl name="webhook" placeholder="https://example.com/hook" />
          </ChannelRow>
          <ChannelRow id="browser" title="浏览器通知" active={false} status="页面在后台时用系统通知提醒新邮件和计划" actions={
            <button
              className="btn sm"
              disabled={!('Notification' in window) || Notification.permission === 'granted'}
              onClick={() => Notification.requestPermission().then((p) => toast(p === 'granted' ? '已开启' : '浏览器拒绝了通知权限'))}
            >
              <Bell size={14} /> {'Notification' in window && Notification.permission === 'granted' ? '已开启' : '开启'}
            </button>
          } />
        </div>
      </Section>

      <Section title="推送规则">
        <div className="card">
          <Setting title="新邮件通知" hint="每个邮箱还可以在邮箱设置里单独关闭">
            <Switch checked={s.notifyMail} onChange={(v) => set({ notifyMail: v })} />
          </Setting>
          <Setting
            title="只推送重要邮件"
            hint={
              ai.data?.active.filter
                ? '由 AI 判断（设置 → AI → 通知过滤），营销、社交动态和普通系统通知不再推送'
                : '按本地规则判断（发件人、退订链接、促销关键词等），准确率有限；在 AI 设置里开启"通知过滤"可以更准'
            }
          >
            <Switch checked={s.importantOnly} onChange={(v) => set({ importantOnly: v })} />
          </Setting>
          <Setting title="验证码邮件始终通知" hint="识别到验证码的邮件无视免打扰和过滤，通知里直接带上验证码">
            <Switch checked={s.codeAlways} onChange={(v) => set({ codeAlways: v })} />
          </Setting>
          <Setting title="免打扰时段" hint="这段时间内不推送新邮件；计划提醒不受影响。起止相同即关闭">
            <input className="input" type="time" value={s.quietStart} onChange={(e) => e.target.value && set({ quietStart: e.target.value })} />
            <span className="muted">至</span>
            <input className="input" type="time" value={s.quietEnd} onChange={(e) => e.target.value && set({ quietEnd: e.target.value })} />
          </Setting>
          <SenderRule title="重点发件人" hint="始终通知并加星标记，不受免打扰限制。每行一个邮箱地址或域名" value={s.vipSenders} onSave={(v) => set({ vipSenders: v })} />
          <SenderRule title="屏蔽通知的发件人" hint="这些发件人的邮件照常接收，但不推送。每行一个邮箱地址或域名" value={s.mutedSenders} onSave={(v) => set({ mutedSenders: v })} />
        </div>
      </Section>

      <Section title="计划与早报">
        <div className="card">
          <Setting title="每日早报" hint="汇总今天的计划和未读邮件数">
            {s.digestTime && <input className="input" type="time" value={s.digestTime} onChange={(e) => e.target.value && set({ digestTime: e.target.value })} />}
            <Switch checked={!!s.digestTime} onChange={(v) => set({ digestTime: v ? '08:30' : '' })} />
          </Setting>
          <Setting title="计划没处理时再次提醒" hint="新建计划的默认值，单个计划可单独调整">
            <select className="select" value={s.nagInterval} onChange={(e) => set({ nagInterval: Number(e.target.value) })}>
              <option value={0}>只提醒一次</option>
              <option value={5}>每 5 分钟</option>
              <option value={15}>每 15 分钟</option>
              <option value={30}>每 30 分钟</option>
              <option value={60}>每小时</option>
            </select>
          </Setting>
        </div>
      </Section>

      {bind && (
        <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && (setBind(null), bots.refetch())}>
          <div className="dialog">
            <h2>绑定聊天机器人</h2>
            <div className="bind-code">
              <span className="muted small">绑定码（15 分钟内有效）</span>
              <b>{bind.code}</b>
              <button className="btn sm" onClick={() => copyText(bind.code)}><Copy size={14} /> 复制</button>
            </div>
            {bind.hints.map((h) => (
              <Setting key={h.platform} title={h.label} hint={h.text}>
                {h.url && <a className="btn sm accent" href={h.url} target="_blank" rel="noopener noreferrer">打开</a>}
              </Setting>
            ))}
            {!enabledBots.length && <div className="muted">还没有启用任何聊天平台。</div>}
            <div className="dialog-foot">
              <button className="btn primary" onClick={() => (setBind(null), bots.refetch())}>完成</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
