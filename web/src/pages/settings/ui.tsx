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

export function Section({ title, action, hint, children }: { title: string; action?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="row">
        <h2 className="grow">{title}</h2>
        {action}
      </div>
      {hint && <div className="muted small">{hint}</div>}
      {children}
    </section>
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

