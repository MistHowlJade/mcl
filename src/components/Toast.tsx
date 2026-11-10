import React, { createContext, useCallback, useContext, useState } from 'react';

export type ToastKind = 'ok' | 'error' | 'info';
interface ToastItem { id: number; kind: ToastKind; message: string }
interface ToastCtx { toast: (message: string, kind?: ToastKind) => void }

const Ctx = createContext<ToastCtx>({ toast: () => undefined });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const toast = useCallback((message: string, kind: ToastKind = 'ok') => {
    const id = Date.now() + Math.random();
    setItems(prev => [...prev, { id, kind, message }]);
    window.setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 6000);
  }, []);
  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      <div className="toast-stack">
        {items.map(t => <div key={t.id} className={`toast ${t.kind === 'ok' ? '' : t.kind}`}>{t.message}</div>)}
      </div>
    </Ctx.Provider>
  );
}
