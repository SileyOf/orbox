import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

export function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`switch${disabled ? ' off' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  );
}

export function Setting({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
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

const moduleState = (id: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(`orbox.module.${id}`);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
};

/**
 * 设置页的一个区块。给了 id 就是可折叠的"模块"：收起时只显示图标、标题和一行当前状态，
 * 需要改的时候再点开，页面不会被一大堆选项铺满。展开状态记在浏览器里。
 */
export function Section(props: {
  title: string;
  action?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  /** 给了就可以折叠 */
  id?: string;
  icon?: LucideIcon;
  /** 收起时显示的一行状态 */
  summary?: ReactNode;
  defaultOpen?: boolean;
}) {
  const { id, icon: Icon } = props;
  const [open, setOpen] = useState(() => (id ? moduleState(id, !!props.defaultOpen) : true));
  if (!id) {
    return (
      <section className="section">
        <div className="row">
          <h2 className="grow">{props.title}</h2>
          {props.action}
        </div>
        {props.hint && <div className="muted small">{props.hint}</div>}
        {props.children}
      </section>
    );
  }
  const toggle = () => {
    setOpen(!open);
    try {
      localStorage.setItem(`orbox.module.${id}`, open ? '0' : '1');
    } catch {}
  };
  return (
    <section className={`module${open ? ' open' : ''}`}>
      <div className="module-head" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle())}>
        {Icon && (
          <i className="module-icon">
            <Icon size={17} />
          </i>
        )}
        <div className="grow" style={{ minWidth: 0 }}>
          <h2>{props.title}</h2>
          {props.summary && !open && <div className="muted small truncate">{props.summary}</div>}
        </div>
        {open && props.action && <div onClick={(e) => e.stopPropagation()}>{props.action}</div>}
        <ChevronDown size={17} className="module-chevron" />
      </div>
      {open && (
        <div className="module-body">
          {props.hint && <div className="muted small">{props.hint}</div>}
          {props.children}
        </div>
      )}
    </section>
  );
}

/** 需要输入当前密码才能做的操作：弹出一个只问密码的小窗口 */
export function PasswordDialog(props: { title: string; hint?: ReactNode; confirm?: string; onSubmit: (password: string) => Promise<unknown>; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <form
        className="dialog"
        style={{ width: 'min(400px, 100%)' }}
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          props
            .onSubmit(password)
            .catch((err) => setError(err.message))
            .finally(() => setBusy(false));
        }}
      >
        <h2>{props.title}</h2>
        {props.hint && <div className="muted small">{props.hint}</div>}
        <label className="field">
          <span>当前登录密码</span>
          <input className="input" type="password" required autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div style={{ color: 'var(--danger)' }}>{error}</div>}
        <div className="dialog-foot">
          <button type="button" className="btn ghost" onClick={props.onClose}>
            取消
          </button>
          <button className="btn primary" disabled={busy}>
            {props.confirm || '确认'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function SenderRule(props: { title: string; hint: string; value: string[]; onSave: (v: string[]) => void }) {
  const [text, setText] = useState(props.value.join('\n'));
  const parse = () => [...new Set(text.split(/[\n,，;；\s]+/).map((v) => v.trim().toLowerCase()).filter((v) => v.length >= 3))];
  return (
    <div className="setting" style={{ alignItems: 'flex-start' }}>
      <div>
        <div>{props.title}</div>
        <div className="muted small">{props.hint}</div>
      </div>
      <textarea
        className="textarea"
        style={{ width: 260, minHeight: 64 }}
        placeholder={'boss@example.com\ngithub.com'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => parse().join() !== props.value.join() && props.onSave(parse())}
      />
    </div>
  );
}

