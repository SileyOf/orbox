import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAccounts, useSaveSettings, useUser } from '../../App';
import { api } from '../../api';
import type { AiInfo, AiProvider, AiTaskName, AiTaskSetting } from '../../api';
import { toast, toastError } from '../../lib';
import { Section, Setting, Switch } from './ui';

export const PROVIDER_PRESETS: { label: string; kind: 'anthropic' | 'openai'; baseUrl: string; model: string }[] = [
  { label: 'Claude', kind: 'anthropic', baseUrl: '', model: 'claude-opus-5-5' },
  { label: 'OpenAI', kind: 'openai', baseUrl: '', model: 'gpt-5' },
  { label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: '小米 MiMo', kind: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1', model: '' },
  { label: '通义千问', kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: 'Kimi', kind: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-turbo-preview' },
  { label: '智谱', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: '硅基流动', kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', model: '' },
  { label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
  { label: 'Ollama（本机）', kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen3' },
];

/** 添加 / 编辑一个模型服务。endpoint 区分个人服务和后台的共享服务 */
export function ProviderDialog(props: { provider: AiProvider | null; endpoint: string; onClose: (changed: boolean) => void }) {
  const p = props.provider;
  const [f, setF] = useState({ name: p?.name ?? '', kind: p?.kind ?? ('openai' as 'anthropic' | 'openai'), baseUrl: p?.baseUrl ?? '', defaultModel: p?.defaultModel ?? '', apiKey: '' });
  const [models, setModels] = useState<string[]>(p?.models ?? []);
  const [busy, setBusy] = useState<'' | 'test' | 'save' | 'models'>('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (patch: Partial<typeof f>) => setF({ ...f, ...patch });

  async function test() {
    setBusy('test');
    setResult(null);
    try {
      const r = await api<{ reply: string; ms: number }>('/ai/providers/test', { body: { ...f, id: p?.id, apiKey: f.apiKey || undefined } });
      setResult({ ok: true, text: `连接正常，${r.ms} ms，模型回复"${r.reply}"` });
    } catch (e: any) {
      setResult({ ok: false, text: e.message });
    } finally {
      setBusy('');
    }
  }

  async function fetchModels() {
    if (!p) return toast('先保存服务，再获取模型列表');
    setBusy('models');
    try {
      const r = await api<{ models: string[] }>(`/ai/providers/${p.id}/models`, { method: 'POST' });
      setModels(r.models);
      toast(`找到 ${r.models.length} 个模型`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy('');
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy('save');
    try {
      const body = { ...f, name: f.name || PROVIDER_PRESETS.find((x) => x.baseUrl === f.baseUrl && x.kind === f.kind)?.label || f.baseUrl || f.kind, apiKey: f.apiKey || undefined };
      await api(p ? `${props.endpoint}/${p.id}` : props.endpoint, { method: p ? 'PUT' : 'POST', body });
      props.onClose(true);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose(false)}>
      <form className="dialog" onSubmit={submit}>
        <h2>{p ? '编辑模型服务' : '添加模型服务'}</h2>
        {!p && (
          <div className="swatches" style={{ gap: 6 }}>
            {PROVIDER_PRESETS.map((x) => (
              <button
                type="button"
                key={x.label}
                className={`chip${f.kind === x.kind && f.baseUrl === x.baseUrl ? ' accent' : ''}`}
                style={{ border: 0, cursor: 'pointer' }}
                onClick={() => set({ name: x.label, kind: x.kind, baseUrl: x.baseUrl, defaultModel: x.model })}
              >
                {x.label}
              </button>
            ))}
          </div>
        )}
        <div className="grid2">
          <label className="field">
            <span>名称</span>
            <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} placeholder="例如 DeepSeek" />
          </label>
          <label className="field">
            <span>接口类型</span>
            <select className="select" value={f.kind} onChange={(e) => set({ kind: e.target.value as 'anthropic' | 'openai' })}>
              <option value="openai">OpenAI 兼容（大多数服务）</option>
              <option value="anthropic">Claude（Anthropic API）</option>
            </select>
          </label>
        </div>
        <label className="field">
          <span>接口地址（留空用官方地址）</span>
          <input className="input" value={f.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder={f.kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} />
        </label>
        <label className="field">
          <span>API Key</span>
          <input className="input" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={p ? '已保存，留空则不修改' : '本机 Ollama 可留空'} />
        </label>
        <label className="field">
          <span>默认模型（任务没单独指定时用它）</span>
          <div className="row">
            <input className="input grow" list="provider-models" value={f.defaultModel} onChange={(e) => set({ defaultModel: e.target.value })} required placeholder="模型名" />
            <button type="button" className="btn sm" disabled={!p || !!busy} onClick={fetchModels} title={p ? '从服务获取可用模型' : '保存后可获取'}>
              <RefreshCw size={14} className={busy === 'models' ? 'spin' : ''} /> 模型列表
            </button>
          </div>
          <datalist id="provider-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
        </label>
        {result && <div className={result.ok ? 'banner' : 'banner warn'}>{result.text}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={() => props.onClose(false)}>取消</button>
          <button type="button" className="btn" disabled={!!busy || !f.defaultModel} onClick={test}><Zap size={14} /> {busy === 'test' ? '测试中…' : '测试'}</button>
          <button className="btn primary" disabled={!!busy}>保存</button>
        </div>
      </form>
    </div>
  );
}

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

export function AiPage() {
  const user = useUser();
  const qc = useQueryClient();
  const save = useSaveSettings();
  const { data: accounts = [] } = useAccounts();
  const info = useQuery({ queryKey: ['ai'], queryFn: () => api<AiInfo>('/ai') });
  const usage = useQuery({ queryKey: ['ai-usage'], queryFn: () => api<{ task: string; model: string; calls: number; failures: number; input_tokens: number; output_tokens: number }[]>('/ai/usage') });
  const [editing, setEditing] = useState<AiProvider | 'new' | null>(null);
  const [tasks, setTasks] = useState<Record<AiTaskName, AiTaskSetting> | null>(null);
  useEffect(() => {
    if (info.data) setTasks(info.data.tasks);
  }, [info.data]);

  const providers = info.data?.providers ?? [];
  const meta = info.data?.meta;
  const aiAccounts = accounts.filter((a) => a.ai_enabled);

  async function updateTask(name: AiTaskName, patch: Partial<AiTaskSetting>) {
    if (!tasks) return;
    const next = { ...tasks, [name]: { ...tasks[name], ...patch } };
    setTasks(next);
    try {
      await api('/ai/tasks', { method: 'PUT', body: { tasks: next } });
      qc.invalidateQueries({ queryKey: ['ai'] });
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <>
      <Section
        title="模型服务"
        hint="可以同时接入多个服务：便宜的模型做高频小任务，强的模型做理解和写作。邮件内容会发给对应的服务商。"
        action={<button className="btn sm" onClick={() => setEditing('new')}><Plus size={15} /> 添加</button>}
      >
        <div className="card">
          {providers.map((p) => (
            <Setting
              key={p.id}
              title={<>{p.name} {p.shared && <span className="chip" style={{ height: 20 }}>管理员共享</span>}</>}
              hint={`${p.kind === 'anthropic' ? 'Claude' : 'OpenAI 兼容'} · ${p.baseUrl || '官方地址'} · 默认 ${p.defaultModel}`}
            >
              {!p.shared && (
                <>
                  <button className="icon-btn" title="编辑" onClick={() => setEditing(p)}><Pencil size={16} /></button>
                  <button className="icon-btn" title="删除" onClick={() => confirm(`删除模型服务「${p.name}」？用到它的任务会被关闭。`) && api(`/ai/providers/${p.id}`, { method: 'DELETE' }).then(() => info.refetch())}>
                    <Trash2 size={16} />
                  </button>
                </>
              )}
            </Setting>
          ))}
          {!providers.length && <div className="setting muted">还没有模型服务。添加一个后，摘要、翻译、助手等功能就能用了。</div>}
        </div>
        <div className="muted small">
          {aiAccounts.length
            ? `允许 AI 读取的邮箱：${aiAccounts.map((a) => a.name).join('、')}。`
            : '还没有邮箱允许 AI 读取，AI 功能不会处理任何邮件。'}
          <Link to="/settings/mailboxes">在邮箱设置里修改</Link>
        </div>
      </Section>

      {tasks && meta && (
        <Section title="任务分配" hint="每项任务都可以单独选择模型或关闭。标为「快速」的是每封新邮件都会触发的小任务，建议用便宜快速的模型；关闭时使用本地规则。">
          <div className="card">
            {(Object.keys(meta) as AiTaskName[]).map((name) => {
              const m = meta[name];
              const t = tasks[name];
              const provider = providers.find((p) => p.id === t.providerId);
              return (
                <div className="task-route" key={name}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div>
                      {m.label} <span className={`chip${m.tier === 'fast' ? '' : ' accent'}`} style={{ height: 20 }}>{m.tier === 'fast' ? '快速' : '强'}</span>
                    </div>
                    <div className="muted small">
                      {m.hint}
                      {!t.enabled && m.local && ` · 当前使用${m.local}`}
                      {!t.enabled && !m.local && ' · 当前关闭'}
                    </div>
                  </div>
                  <select className="select" style={{ width: 150 }} value={t.providerId ?? ''} disabled={!providers.length} onChange={(e) => updateTask(name, { providerId: Number(e.target.value) || null, model: '' })}>
                    {!providers.length && <option value="">没有服务</option>}
                    {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <input
                    className="input"
                    style={{ width: 170 }}
                    list={`models-${name}`}
                    placeholder={provider ? `默认 ${provider.defaultModel}` : '模型'}
                    defaultValue={t.model}
                    key={`${name}-${t.providerId}`}
                    onBlur={(e) => e.target.value.trim() !== t.model && updateTask(name, { model: e.target.value.trim() })}
                  />
                  <datalist id={`models-${name}`}>{(provider?.models || []).map((x) => <option key={x} value={x} />)}</datalist>
                  <Switch checked={t.enabled} disabled={!providers.length} onChange={(v) => updateTask(name, { enabled: v })} />
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="翻译">
        <div className="card">
          <Setting title="翻译成" hint="邮件里的翻译按钮和机器人里的翻译都用这个语言">
            <select className="select" value={user.settings.translateTo} onChange={(e) => save({ settings: { translateTo: e.target.value } }).catch(toastError)}>
              {['简体中文', '繁體中文', 'English', '日本語', '한국어', 'Français', 'Deutsch', 'Español', 'Русский'].map((l) => <option key={l}>{l}</option>)}
            </select>
          </Setting>
        </div>
      </Section>

      <Section title="最近 30 天用量">
        <div className="card">
          {(usage.data || []).map((u) => (
            <Setting
              key={`${u.task}-${u.model}`}
              title={<>{meta?.[u.task as AiTaskName]?.label ?? (u.task === 'triage' ? '新邮件分拣' : u.task === 'test' ? '连接测试' : u.task)} <span className="muted small">· {u.model}</span></>}
              hint={`${u.calls} 次调用${Number(u.failures) ? `，失败 ${u.failures} 次` : ''}`}
            >
              <span className="muted small">输入 {fmt(Number(u.input_tokens))} · 输出 {fmt(Number(u.output_tokens))} tokens</span>
            </Setting>
          ))}
          {!usage.data?.length && <div className="setting muted">还没有调用记录。</div>}
        </div>
      </Section>

      {editing && (
        <ProviderDialog
          provider={editing === 'new' ? null : editing}
          endpoint="/ai/providers"
          onClose={(changed) => {
            setEditing(null);
            if (changed) info.refetch();
          }}
        />
      )}
    </>
  );
}
