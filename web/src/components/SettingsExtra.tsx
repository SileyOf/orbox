import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, Send, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useSaveSettings, useUser } from '../App';
import { api, folderLabel } from '../api';
import type { Account, User } from '../api';
import { copyText, toast, toastError } from '../lib';

function Row({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="setting">
      <div>
        <div>{title}</div>
        {hint && <div className="muted small">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

// ---------------- 聊天机器人 ----------------

interface BotsInfo {
  platforms: { platform: string; label: string; enabled: boolean; name: string | null }[];
  links: { platform: string; username: string }[];
}

export function BotsSection() {
  const bots = useQuery({ queryKey: ['bots'], queryFn: () => api<BotsInfo>('/bots') });
  const [bind, setBind] = useState<{ code: string; hints: { platform: string; label: string; url?: string; text: string }[] } | null>(null);
  const enabled = (bots.data?.platforms || []).filter((p) => p.enabled);

  async function startBind() {
    try {
      setBind(await api('/bots/code', { method: 'POST' }));
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <section className="section">
      <div className="row">
        <h2 className="grow">聊天机器人</h2>
        {enabled.length > 0 && <button className="btn sm" onClick={startBind}><Plus size={15} /> 绑定</button>}
      </div>
      <div className="card">
        {(bots.data?.platforms || []).map((p) => {
          const link = bots.data!.links.find((l) => l.platform === p.platform);
          return (
            <Row
              key={p.platform}
              title={p.label}
              hint={
                !p.enabled
                  ? '服务器没有配置这个平台（见部署文档）'
                  : !p.name
                    ? '正在连接…'
                    : link
                      ? `已绑定${link.username ? ` ${link.username}` : ''} · 机器人 ${p.name}`
                      : `未绑定 · 机器人 ${p.name}`
              }
            >
              {link && (
                <button className="btn sm danger" onClick={() => api(`/bots/${p.platform}`, { method: 'DELETE' }).then(() => bots.refetch())}>解绑</button>
              )}
            </Row>
          );
        })}
        {bots.data?.links.length ? (
          <Row title="发送测试" hint="向所有已绑定的平台发一条测试消息或今天的早报">
            <button className="btn sm" onClick={() => api('/bots/test', { body: {} }).then(() => toast('已发送')).catch(toastError)}><Send size={14} /> 测试</button>
            <button className="btn sm" onClick={() => api('/bots/test', { body: { kind: 'digest' } }).then(() => toast('已发送')).catch(toastError)}>早报</button>
          </Row>
        ) : null}
      </div>
      <div className="muted small">
        绑定后可以在聊天软件里收新邮件和计划提醒，直接阅读全文、下载附件、看链接、翻译和摘要；配置了 AI 后还能直接用自然语言提问。
      </div>
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
              <Row key={h.platform} title={h.label} hint={h.text}>
                {h.url && <a className="btn sm accent" href={h.url} target="_blank" rel="noopener noreferrer">打开</a>}
              </Row>
            ))}
            <div className="dialog-foot">
              <button className="btn primary" onClick={() => (setBind(null), bots.refetch())}>完成</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------- AI 模型 ----------------

interface AiInfo {
  provider?: 'anthropic' | 'openai';
  baseUrl?: string;
  model?: string;
  fastModel?: string;
  hasKey?: boolean;
  defaults: Record<'anthropic' | 'openai', string>;
  shared: { provider: string; model: string } | null;
  active: boolean;
}

const PRESETS: { label: string; provider: 'anthropic' | 'openai'; baseUrl: string; model: string }[] = [
  { label: 'Claude', provider: 'anthropic', baseUrl: '', model: 'claude-opus-5-5' },
  { label: 'OpenAI', provider: 'openai', baseUrl: '', model: 'gpt-5' },
  { label: 'DeepSeek', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '通义千问', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: 'Kimi', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-turbo-preview' },
  { label: 'OpenRouter', provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { label: 'Ollama（本机）', provider: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3' },
];

export function AiSection() {
  const user = useUser();
  const qc = useQueryClient();
  const save = useSaveSettings();
  const info = useQuery({ queryKey: ['ai-config'], queryFn: () => api<AiInfo>('/ai/config') });
  const [form, setForm] = useState<{ provider: 'anthropic' | 'openai'; baseUrl: string; model: string; fastModel: string; apiKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const d = info.data;
  const f = form ?? {
    provider: d?.provider || 'anthropic',
    baseUrl: d?.baseUrl || '',
    model: d?.model || d?.defaults.anthropic || 'claude-opus-5-5',
    fastModel: d?.fastModel || '',
    apiKey: '',
  };
  const set = (patch: Partial<typeof f>) => setForm({ ...f, ...patch });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const u = await api<User>('/ai/config', { method: 'PUT', body: { ...f, apiKey: f.apiKey || undefined } });
      qc.setQueryData(['me'], u);
      await info.refetch();
      setForm(null);
      const t = await api<{ reply: string; ms: number }>('/ai/test', { method: 'POST' });
      toast(`已保存，模型响应正常（${t.ms} ms）`);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="section" id="ai">
      <h2>AI</h2>
      <form className="card" onSubmit={submit} style={{ paddingTop: 14, paddingBottom: 14, display: 'grid', gap: 12 }}>
        <div className="muted small">
          {d?.active ? '✅ AI 已可用。' : '还没有可用的模型。'}
          邮件内容会发给你配置的模型服务商；每个邮箱需要在账号设置里单独打开"允许 AI 读取"才会被用到。
          {d?.shared && !d.hasKey && ` 当前使用服务器提供的默认模型（${d.shared.model}），也可以填自己的。`}
        </div>
        <div className="swatches" style={{ gap: 6 }}>
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.label}
              className={`chip${f.provider === p.provider && f.baseUrl === p.baseUrl ? ' accent' : ''}`}
              style={{ border: 0, cursor: 'pointer' }}
              onClick={() => set({ provider: p.provider, baseUrl: p.baseUrl, model: p.model || f.model, apiKey: '' })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid2">
          <label className="field">
            <span>接口类型</span>
            <select className="select" value={f.provider} onChange={(e) => set({ provider: e.target.value as 'anthropic' | 'openai' })}>
              <option value="anthropic">Claude（Anthropic API）</option>
              <option value="openai">OpenAI 兼容接口</option>
            </select>
          </label>
          <label className="field">
            <span>接口地址（留空用官方地址）</span>
            <input className="input" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={f.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} />
          </label>
          <label className="field">
            <span>模型</span>
            <input className="input" value={f.model} onChange={(e) => set({ model: e.target.value })} placeholder={d?.defaults[f.provider]} required />
          </label>
          <label className="field">
            <span>快速模型（分类用，可留空）</span>
            <input className="input" value={f.fastModel} onChange={(e) => set({ fastModel: e.target.value })} placeholder={f.provider === 'anthropic' ? '例如 claude-haiku-5-5' : '留空则与主模型相同'} />
          </label>
        </div>
        <label className="field">
          <span>API Key</span>
          <input className="input" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={d?.hasKey && d.provider === f.provider ? '已保存，留空则不修改' : ''} />
        </label>
        <div className="row">
          <button className="btn primary" disabled={busy}>{busy ? '正在验证…' : '保存并测试'}</button>
          {d?.hasKey && (
            <button
              type="button"
              className="btn ghost danger"
              onClick={() => api<User>('/ai/config', { method: 'DELETE' }).then((u) => (qc.setQueryData(['me'], u), info.refetch(), setForm(null)))}
            >
              清除
            </button>
          )}
        </div>
      </form>
      <div className="card">
        <Row title="翻译成" hint="邮件里的翻译按钮和机器人里的翻译都用这个语言">
          <select className="select" value={user.settings.translateTo} onChange={(e) => save({ settings: { translateTo: e.target.value } }).catch(toastError)}>
            {['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'].map((l) => <option key={l}>{l}</option>)}
          </select>
        </Row>
        <Row title="只推送重要邮件" hint="由 AI 判断，营销、社交动态、普通系统通知不再推送；验证码和重点发件人始终推送。每封新邮件会多一次模型调用">
          <label className="switch">
            <input type="checkbox" checked={user.settings.aiFilter} onChange={(e) => save({ settings: { aiFilter: e.target.checked } }).catch(toastError)} />
            <i />
          </label>
        </Row>
      </div>
    </section>
  );
}

// ---------------- MCP：给外部 AI 用的连接 ----------------

interface TokenRow {
  id: number;
  name: string;
  allow_send: number;
  last_used_at: string | null;
  created_at: string;
}

export function McpSection() {
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api<TokenRow[]>('/tokens') });
  const [name, setName] = useState('');
  const [allowSend, setAllowSend] = useState(false);
  const [created, setCreated] = useState<{ token: string; mcpUrl: string } | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      setCreated(await api('/tokens', { body: { name: name || '外部 AI', allowSend } }));
      setName('');
      setAllowSend(false);
      tokens.refetch();
    } catch (err) {
      toastError(err);
    }
  }

  const snippet = created
    ? JSON.stringify({ mcpServers: { orbox: { type: 'http', url: created.mcpUrl, headers: { Authorization: `Bearer ${created.token}` } } } }, null, 2)
    : '';

  return (
    <section className="section">
      <h2>AI 连接（MCP）</h2>
      <div className="muted small">
        让 Hermes、Claude Desktop、Cursor 等支持 MCP 的 AI 工具直接查邮件、读邮件、管理计划、起草邮件。
        它们只能访问开启了"允许 AI 读取"的邮箱。
      </div>
      <div className="card">
        {(tokens.data || []).map((t) => (
          <Row
            key={t.id}
            title={<><KeyRound size={14} style={{ verticalAlign: -2 }} /> {t.name}</>}
            hint={`${t.allow_send ? '可直接发信' : '只能起草，不能发信'} · ${t.last_used_at ? `最近使用 ${new Date(t.last_used_at).toLocaleString()}` : '尚未使用'}`}
          >
            <button className="icon-btn" title="撤销" onClick={() => confirm(`撤销「${t.name}」？使用它的 AI 工具将无法再连接。`) && api(`/tokens/${t.id}`, { method: 'DELETE' }).then(() => tokens.refetch())}>
              <Trash2 size={16} />
            </button>
          </Row>
        ))}
        <form className="setting" onSubmit={create}>
          <input className="input grow" placeholder="名称，例如 Hermes" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          <label className="row small" title="开启后外部 AI 可以不经确认直接发出邮件">
            <input type="checkbox" checked={allowSend} onChange={(e) => setAllowSend(e.target.checked)} /> 允许直接发信
          </label>
          <button className="btn sm accent">生成令牌</button>
        </form>
      </div>
      {created && (
        <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && setCreated(null)}>
          <div className="dialog">
            <div className="row">
              <h2 className="grow">令牌已生成</h2>
              <button className="icon-btn" onClick={() => setCreated(null)}><X size={18} /></button>
            </div>
            <div className="banner warn">令牌只显示这一次，请现在复制保存。泄露后在这里撤销即可。</div>
            <label className="field">
              <span>MCP 地址</span>
              <div className="row"><input className="input grow" readOnly value={created.mcpUrl} /><button className="btn sm" onClick={() => copyText(created.mcpUrl, '已复制')}><Copy size={14} /></button></div>
            </label>
            <label className="field">
              <span>令牌（作为 Authorization: Bearer 发送）</span>
              <div className="row"><input className="input grow" readOnly value={created.token} /><button className="btn sm" onClick={() => copyText(created.token, '已复制')}><Copy size={14} /></button></div>
            </label>
            <label className="field">
              <span>通用配置（Claude Desktop、Cursor 等，HTTP 传输）</span>
              <pre className="code-block">{snippet}</pre>
            </label>
            <div className="muted small">Hermes 等其他工具：在它的 MCP 配置里添加一个 HTTP（Streamable HTTP）服务器，填上面的地址，并加一个 Authorization 请求头。</div>
            <div className="dialog-foot">
              <button className="btn" onClick={() => copyText(snippet, '已复制配置')}><Copy size={14} /> 复制配置</button>
              <button className="btn primary" onClick={() => setCreated(null)}>完成</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------- 服务器端过滤规则（Sieve） ----------------

type Field = 'from' | 'to' | 'cc' | 'subject' | 'list';
type Op = 'contains' | 'not_contains' | 'is' | 'domain';
type Action =
  | { type: 'fileinto'; folder: string }
  | { type: 'markread' }
  | { type: 'flag' }
  | { type: 'discard' }
  | { type: 'redirect'; address: string; keep: boolean }
  | { type: 'stop' };
interface Rule {
  name: string;
  enabled: boolean;
  match: 'all' | 'any';
  conditions: { field: Field; op: Op; value: string }[];
  actions: Action[];
}

const FIELDS: Record<Field, string> = { from: '发件人', to: '收件人', cc: '抄送', subject: '主题', list: '邮件列表' };
const OPS: Record<Op, string> = { contains: '包含', not_contains: '不包含', is: '等于', domain: '域名是' };
const ACTIONS: Record<Action['type'], string> = {
  fileinto: '移动到文件夹',
  markread: '标为已读',
  flag: '加星标',
  discard: '直接删除',
  redirect: '转发到',
  stop: '不再执行后面的规则',
};

const blankRule = (): Rule => ({ name: '', enabled: true, match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'markread' }] });

function newAction(type: Action['type'], folder: string): Action {
  if (type === 'fileinto') return { type, folder };
  if (type === 'redirect') return { type, address: '', keep: true };
  return { type } as Action;
}

export function SieveDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const data = useQuery({
    queryKey: ['sieve', account.id],
    queryFn: () => api<{ supported: boolean; error?: string; rules: Rule[]; base: string | null; script: string | null }>(`/accounts/${account.id}/sieve`),
    retry: false,
  });
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = rules ?? data.data?.rules ?? [];
  const folders = account.folders.filter((f) => f.role !== 'inbox');
  const update = (i: number, patch: Partial<Rule>) => setRules(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function save() {
    setBusy(true);
    try {
      const r = await api<{ script: string }>(`/accounts/${account.id}/sieve`, { method: 'PUT', body: { rules: list } });
      setScript(r.script);
      toast('规则已保存到邮件服务器，新邮件到达时立即生效');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ width: 'min(760px, 100%)' }}>
        <div className="row">
          <h2 className="grow">过滤规则 · {account.name}</h2>
          <button className="icon-btn" onClick={onClose}><X size={18} /></button>
        </div>
        {data.isLoading && <div className="muted">正在连接邮件服务器…</div>}
        {data.data && !data.data.supported && (
          <div className="banner warn">无法连接这个邮箱的 ManageSieve 服务（端口 {account.sieve_port ?? 4190}）：{data.data.error}</div>
        )}
        {data.data?.supported && (
          <>
            <div className="muted small">
              规则保存在邮件服务器上（Sieve），邮件到达时由服务器执行，不依赖 Orbox 在线。按从上到下的顺序执行。
              {data.data.base && ` 原有的规则脚本「${data.data.base}」会继续在这些规则之后生效。`}
            </div>
            {list.map((r, i) => (
              <div className="card rule" key={i}>
                <div className="row">
                  <input className="input grow" placeholder="规则名称" value={r.name} onChange={(e) => update(i, { name: e.target.value })} />
                  <label className="switch" title="启用">
                    <input type="checkbox" checked={r.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
                    <i />
                  </label>
                  <button className="icon-btn" title="删除规则" onClick={() => setRules(list.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
                </div>
                <div className="row small">
                  当
                  <select className="select" style={{ width: 'auto', height: 32 }} value={r.match} onChange={(e) => update(i, { match: e.target.value as Rule['match'] })}>
                    <option value="all">满足全部条件</option>
                    <option value="any">满足任一条件</option>
                  </select>
                  时
                </div>
                {r.conditions.map((c, k) => (
                  <div className="row" key={k}>
                    <select className="select" style={{ width: 110 }} value={c.field} onChange={(e) => update(i, { conditions: r.conditions.map((x, j) => (j === k ? { ...x, field: e.target.value as Field } : x)) })}>
                      {Object.entries(FIELDS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <select className="select" style={{ width: 100 }} value={c.op} onChange={(e) => update(i, { conditions: r.conditions.map((x, j) => (j === k ? { ...x, op: e.target.value as Op } : x)) })}>
                      {Object.entries(OPS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    <input className="input grow" value={c.value} placeholder={c.op === 'domain' ? 'example.com' : ''} onChange={(e) => update(i, { conditions: r.conditions.map((x, j) => (j === k ? { ...x, value: e.target.value } : x)) })} />
                    <button className="icon-btn" disabled={r.conditions.length === 1} onClick={() => update(i, { conditions: r.conditions.filter((_, j) => j !== k) })}><X size={15} /></button>
                  </div>
                ))}
                <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => update(i, { conditions: [...r.conditions, { field: 'subject', op: 'contains', value: '' }] })}><Plus size={14} /> 条件</button>
                <div className="small muted">就</div>
                {r.actions.map((a, k) => (
                  <div className="row" key={k}>
                    <select className="select" style={{ width: 170 }} value={a.type} onChange={(e) => update(i, { actions: r.actions.map((x, j) => (j === k ? newAction(e.target.value as Action['type'], folders[0]?.path || 'Archive') : x)) })}>
                      {Object.entries(ACTIONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                    {a.type === 'fileinto' && (
                      <select className="select grow" value={a.folder} onChange={(e) => update(i, { actions: r.actions.map((x, j) => (j === k ? { ...a, folder: e.target.value } : x)) })}>
                        {folders.map((f) => <option key={f.id} value={f.path}>{folderLabel(f)}</option>)}
                      </select>
                    )}
                    {a.type === 'redirect' && (
                      <>
                        <input className="input grow" type="email" placeholder="转发到的邮箱" value={a.address} onChange={(e) => update(i, { actions: r.actions.map((x, j) => (j === k ? { ...a, address: e.target.value } : x)) })} />
                        <label className="row small"><input type="checkbox" checked={a.keep} onChange={(e) => update(i, { actions: r.actions.map((x, j) => (j === k ? { ...a, keep: e.target.checked } : x)) })} />保留一份</label>
                      </>
                    )}
                    <span className="grow" />
                    <button className="icon-btn" disabled={r.actions.length === 1} onClick={() => update(i, { actions: r.actions.filter((_, j) => j !== k) })}><X size={15} /></button>
                  </div>
                ))}
                <button className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => update(i, { actions: [...r.actions, { type: 'flag' }] })}><Plus size={14} /> 动作</button>
              </div>
            ))}
            <button className="btn" style={{ justifySelf: 'start' }} onClick={() => setRules([...list, blankRule()])}><Plus size={15} /> 新规则</button>
            {(script ?? data.data.script) && (
              <details>
                <summary className="muted small" style={{ cursor: 'pointer' }}>查看生成的 Sieve 脚本</summary>
                <pre className="code-block">{script ?? data.data.script}</pre>
              </details>
            )}
            <div className="dialog-foot">
              <button className="btn ghost" onClick={onClose}>关闭</button>
              <button className="btn primary" disabled={busy || !rules} onClick={save}>{busy ? '保存中…' : '保存到服务器'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
