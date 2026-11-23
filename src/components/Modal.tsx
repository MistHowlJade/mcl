import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export function Modal({ title, onClose, children, footer, wide }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** 表单型弹窗（创建实例/服务器、高级设置）用更宽的版式，避免标签与控件挤在一起 */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const titleId = useId();

  // PCL2/Modrinth 共有的基础交互：Esc 与遮罩都能关闭，打开时把焦点放到安全/默认动作上。
  // 用 ref 保存回调，避免父组件重渲染时反复重置焦点（弹窗里输入到一半丢焦点很糟）。
  // 弹窗必须挂到 document.body：页面切换动画会给祖先留下 transform，
  // position: fixed 会被祖先“捕获”，导致弹窗被裁切/遮罩盖不到侧边栏（真机截图复现过）。
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
      // 简易焦点陷阱：Tab 在弹窗内循环，避免键盘焦点跑到被遮住的页面上
      if (e.key !== 'Tab' || !ref.current) return;
      const focusables = Array.from(ref.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter(el => el.offsetParent !== null);
      if (focusables.length === 0) { e.preventDefault(); ref.current.focus(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === ref.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    const target = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current;
    target?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      // 关闭后把焦点还给打开它的按钮，键盘用户不会“迷路”
      if (previous && document.contains(previous)) previous.focus();
    };
  }, []);

  return createPortal(
    <div
      className="modal-mask"
      onMouseDown={e => { if (e.target === e.currentTarget) closeRef.current(); }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="winbtn" onClick={onClose} aria-label="关闭"><Icon name="close" size={13} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Tip({ text }: { text: string }) {
  return (
    <span className="tip">
      <button className="tip-btn" tabIndex={0} aria-label="帮助">?</button>
      <span className="tip-pop" role="tooltip">{text}</span>
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      className={`switch ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label ?? '切换'}
      onClick={() => onChange(!checked)}
    />
  );
}

export function ConfirmModal({ title, message, confirmText, danger, onConfirm, onCancel }: {
  title: string; message: string; confirmText?: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} footer={<>
      <button className="btn ghost" data-autofocus={danger ? true : undefined} onClick={onCancel}>取消</button>
      <button className={`btn ${danger ? 'danger' : 'primary'}`} data-autofocus={danger ? undefined : true} onClick={onConfirm}>{confirmText ?? '确定'}</button>
    </>}>
      <p style={{ whiteSpace: 'pre-wrap' }}>{message}</p>
    </Modal>
  );
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '从未';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  return `${d} 天前`;
}
