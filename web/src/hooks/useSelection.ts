import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';

/**
 * 列表多选：
 * - 按住左键在行上拖动，连续选中经过的行（拖到列表边缘会自动滚动）
 * - Shift + 点击选中一段，Ctrl / ⌘ + 点击单独加选或取消
 * - 普通点击：清空多选并打开这一行
 * 行元素需要带 data-index 属性，容器是可滚动的列表。
 */
export function useSelection(ids: number[], container: RefObject<HTMLElement | null>) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dragging, setDragging] = useState(false);
  const anchor = useRef<number | null>(null);
  const drag = useRef<{ start: number; base: Set<number>; active: boolean; x: number; y: number } | null>(null);
  const justDragged = useRef(false);
  const idsRef = useRef(ids);
  idsRef.current = ids;

  // 列表内容变了（翻页、移走邮件）时，去掉已经不在列表里的选择
  useEffect(() => {
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => ids.includes(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [ids.join(',')]);

  const range = (a: number, b: number) => idsRef.current.slice(Math.min(a, b), Math.max(a, b) + 1);

  useEffect(() => {
    let raf = 0;
    let lastY = 0;
    const indexAt = (x: number, y: number) => {
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-index]');
      return row && container.current?.contains(row) ? Number(row.dataset.index) : null;
    };
    const update = (x: number, y: number) => {
      const d = drag.current;
      if (!d) return;
      if (!d.active && Math.hypot(x - d.x, y - d.y) < 6) return;
      const i = indexAt(x, y);
      if (i === null) return;
      if (!d.active) {
        d.active = true;
        setDragging(true);
      }
      setSelected(new Set([...d.base, ...range(d.start, i)]));
    };
    // 拖到容器上下边缘时持续滚动，并顺带更新选择
    const tick = () => {
      const el = container.current;
      if (drag.current?.active && el) {
        const r = el.getBoundingClientRect();
        const speed = lastY < r.top + 48 ? -14 : lastY > r.bottom - 48 ? 14 : 0;
        if (speed) {
          el.scrollTop += speed;
          update(r.left + r.width / 2, Math.min(Math.max(lastY, r.top + 4), r.bottom - 4));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    const move = (e: MouseEvent) => {
      lastY = e.clientY;
      update(e.clientX, e.clientY);
    };
    const up = () => {
      if (drag.current?.active) justDragged.current = true;
      drag.current = null;
      setDragging(false);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      cancelAnimationFrame(raf);
    };
  }, []);

  /** 行上的 onMouseDown */
  function onRowMouseDown(e: ReactMouseEvent, index: number) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, label, select, textarea')) return;
    // 阻止拖动时选中文字
    if (!e.shiftKey) e.preventDefault();
    drag.current = { start: index, base: e.ctrlKey || e.metaKey ? new Set(selected) : new Set(), active: false, x: e.clientX, y: e.clientY };
  }

  /**
   * 行上的 onClick。返回 true 表示这次点击是"打开"，由调用方处理；
   * 多选相关的点击（拖动结束、Shift、Ctrl）在这里消化掉。
   */
  function onRowClick(e: ReactMouseEvent, index: number): boolean {
    // 行里的按钮、复选框、链接各有自己的作用，冒泡上来的点击不算"打开这一行"
    if ((e.target as HTMLElement).closest('button, a, input, label, select, textarea')) return false;
    if (justDragged.current) {
      justDragged.current = false;
      return false;
    }
    const id = idsRef.current[index];
    if (e.shiftKey && anchor.current !== null) {
      const base = e.ctrlKey || e.metaKey ? selected : new Set<number>();
      setSelected(new Set([...base, ...range(anchor.current, index)]));
      window.getSelection()?.removeAllRanges();
      return false;
    }
    anchor.current = index;
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      next.has(id) ? next.delete(id) : next.add(id);
      setSelected(next);
      return false;
    }
    if (selected.size) setSelected(new Set());
    return true;
  }

  function toggle(id: number) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
    anchor.current = idsRef.current.indexOf(id);
  }

  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(ids));
  const clear = () => setSelected(new Set());

  return { selected, setSelected, dragging, onRowMouseDown, onRowClick, toggle, toggleAll, allSelected, clear };
}
