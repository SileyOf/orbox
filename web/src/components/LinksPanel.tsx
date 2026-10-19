import { AlertTriangle, ChevronDown, ExternalLink, Link2 } from 'lucide-react';
import { useState } from 'react';
import { LINK_LABELS } from '../api';
import type { LinkInfo } from '../api';

const KEY_KINDS = new Set(['billing', 'verify', 'account', 'tracking', 'download']);

/** 邮件里的链接：重要的（续费、验证、登录、物流、下载）直接给按钮，其余收在"全部链接"里 */
export function LinksPanel({ links }: { links: LinkInfo[] | null }) {
  const [open, setOpen] = useState(false);
  if (!links?.length) return null;
  const key = links.filter((l) => KEY_KINDS.has(l.kind)).slice(0, 4);
  const suspicious = links.filter((l) => l.suspicious);
  return (
    <div className="links-panel">
      {suspicious.length > 0 && (
        <div className="banner warn">
          <AlertTriangle size={15} />
          有 {suspicious.length} 个链接显示的地址和实际跳转的地址不一致，可能是钓鱼链接，点击前请仔细核对
        </div>
      )}
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {key.map((l) => (
          <a key={l.url} className={`link-chip${l.suspicious ? ' bad' : ''}`} href={l.url} target="_blank" rel="noopener noreferrer" title={l.url}>
            <ExternalLink size={13} />
            <b>{LINK_LABELS[l.kind].split(' / ')[0]}</b>
            <span className="truncate">{l.text || l.domain}</span>
            <span className="muted small">{l.domain}</span>
          </a>
        ))}
        <button className="btn ghost sm" onClick={() => setOpen(!open)}>
          <Link2 size={14} /> 全部链接（{links.length}）
          <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>
      </div>
      {open && (
        <div className="links-list">
          {links.map((l) => (
            <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className={l.suspicious ? 'bad' : ''} title={l.url}>
              <span className="chip">{LINK_LABELS[l.kind]}</span>
              <span className="truncate grow">{l.text || l.url}</span>
              <span className="muted small">{l.domain}</span>
              {l.suspicious && <AlertTriangle size={14} />}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
