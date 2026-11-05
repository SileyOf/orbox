import { useQuery } from '@tanstack/react-query';
import { Copy, KeyRound, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useUser } from '../../App';
import { api } from '../../api';
import { copyText, toastError } from '../../lib';
import { Setting as Row } from './ui';

interface TokenRow {
  id: number;
  name: string;
  allow_send: number;
  last_used_at: string | null;
  created_at: string;
}

export function ConnectPage() {
  const user = useUser();
  if (!user.perms.mcp)
    return (
      <section className="section">
        <h2>AI 连接（MCP）</h2>
        <div className="card empty-hint">管理员没有给你开放 MCP 外部连接。</div>
      </section>
    );
  return <ConnectInner />;
}

function ConnectInner() {
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

