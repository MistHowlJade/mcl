import React, { useEffect, useRef } from 'react';

export function Modal({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // PCL2/Modrinth 共有的基础交互：Esc 与遮罩都能关闭，打开时把焦点放到安全/默认动作上。
  // 用 ref 保存回调，避免父组件重渲染时反复重置焦点（弹窗里输入到一半丢焦点很糟）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); } };
    window.addEventListener('keydown', onKey, true);
    const target = ref.current?.querySelector<HTMLElement>('[data-autofocus]') ?? ref.current;
    target?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={e => e.stopPropagation()}>
        <div className="row spread" style={{ marginBottom: 10 }}>
          <h2>{title}</h2>
          <button className="winbtn" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div>{children}</div>
        {footer && <div className="row modal-footer" style={{ justifyContent: 'flex-end', marginTop: 16 }}>{footer}</div>}
      </div>
    </div>
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
