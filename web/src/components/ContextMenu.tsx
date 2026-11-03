import { ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label?: string;
  icon?: LucideIcon;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 右侧的快捷键提示 */
  hint?: string;
  children?: MenuItem[];
  separator?: boolean;
  /** 不可点击的小标题 */
  heading?: boolean;
}

/** 右键菜单：贴着鼠标弹出，靠近屏幕边缘时自动翻转，支持一级子菜单 */
export function ContextMenu(props: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: props.x, top: props.y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(props.x, window.innerWidth - width - 8)),
      top: Math.max(8, props.y + height > window.innerHeight - 8 ? props.y - height : props.y),
    });
  }, [props.x, props.y]);

  useEffect(() => {
    const close = () => props.onClose();
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    document.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      document.removeEventListener('scroll', close, true);
    };
  }, []);

  return (
    <div ref={ref} className="ctx-menu card" style={pos} onContextMenu={(e) => e.preventDefault()}>
      <MenuList items={props.items} onClose={props.onClose} />
    </div>
  );
}

function MenuList({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      {items.map((item, i) => {
        if (item.separator) return <div key={i} className="ctx-sep" />;
        if (item.heading) return <div key={i} className="ctx-heading">{item.label}</div>;
        const Icon = item.icon;
        return (
          <div key={i} className="ctx-row" onMouseEnter={() => setOpen(item.children ? i : null)}>
            <button
              className={`ctx-item${item.danger ? ' danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                if (item.children) return setOpen(i);
                item.onClick?.();
                onClose();
              }}
            >
              <span className="ctx-icon">{Icon && <Icon size={15} />}</span>
              <span className="grow">{item.label}</span>
              {item.hint && <span className="ctx-hint">{item.hint}</span>}
              {item.children && <ChevronRight size={14} />}
            </button>
            {item.children && open === i && <SubMenu items={item.children} onClose={onClose} />}
          </div>
        );
      })}
    </>
  );
}

function SubMenu({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<'right' | 'left'>('right');
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    if (r.right > window.innerWidth - 8) setSide('left');
    if (r.bottom > window.innerHeight - 8) setShift(window.innerHeight - 8 - r.bottom);
  }, []);
  return (
    <div ref={ref} className={`ctx-menu card ctx-sub ${side}`} style={{ marginTop: shift }}>
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}
