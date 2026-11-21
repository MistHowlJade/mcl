import React, { createContext, useCallback, useContext, useState } from 'react';

export type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; message: string }
interface ToastCtx { toast: (message: string, kind?: ToastKind) => void }

const Ctx = createContext<ToastCtx>({ toast: () => undefined });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems(prev => prev.filter(t => t.id !== id)), []);
  const toast = useCallback((message: string, kind: ToastKind = 'ok') => {
    const id = Date.now() + Math.random();
    setItems(prev => [...prev, { id, kind, message }]);
    window.setTimeout(() => dismiss(id), 6000);
  }, [dismiss]);
  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="toast-stack">
        {items.map(t => (
          <div key={t.id} className={`toast ${t.kind === 'ok' ? '' : t.kind}`} role="status">
            <span className="toast-icon" aria-hidden="true">{t.kind === 'ok' ? '✓' : t.kind === 'error' ? '⚠' : 'ℹ'}</span>
            <span className="toast-text">{t.message}</span>
            <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="关闭提示">✕</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
