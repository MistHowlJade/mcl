import { useCallback, useEffect, useRef, useState } from 'react';
import type { DependencyList, Dispatch, SetStateAction } from 'react';
import { api } from './api';
import { useToast } from '../components/Toast';
import type { InstanceInfo } from '../../electron/shared/types';

/**
 * 实例选择：多个页面共用 localStorage 里的选中实例，并统一处理实例被删除后的回退。
 * idRef 供异步回调读取“当前”实例，避免请求发出后用户切页导致旧结果覆盖新数据。
 */
export function useInstanceSelection() {
  const { toast } = useToast();
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [instanceId, setInstanceId] = useState<string | null>(() => localStorage.getItem('mcl:selectedInstance'));
  const [ready, setReady] = useState(false);
  const idRef = useRef<string | null>(instanceId);

  useEffect(() => {
    api.instancesList()
      .then(list => {
        setInstances(list);
        setInstanceId(prev => (prev && list.some(i => i.id === prev)) ? prev : (list[0]?.id ?? null));
      })
      .catch(e => toast(e instanceof Error ? e.message : String(e), 'error'))
      .finally(() => setReady(true));
    /* eslint-disable-next-line */
  }, []);

  useEffect(() => {
    idRef.current = instanceId;
    if (instanceId) localStorage.setItem('mcl:selectedInstance', instanceId);
  }, [instanceId]);

  return { instances, instanceId, setInstanceId, idRef, ready };
}

/**
 * 列表加载：统一 seq 竞态保护 + loading + 错误提示。
 * deps 变化时先清空旧数据，避免切换实例后短暂显示上一台的内容。
 */
export function useAsyncList<T>(
  load: () => Promise<T[]>,
  deps: DependencyList,
): { items: T[]; setItems: Dispatch<SetStateAction<T[]>>; loading: boolean; reload: () => Promise<void> } {
  const { toast } = useToast();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(async () => {
    const current = ++seq.current;
    setLoading(true);
    try {
      const list = await loadRef.current();
      if (current === seq.current) setItems(list);
    } catch (e) {
      if (current === seq.current) toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      if (current === seq.current) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    setItems([]);
    void reload();
    /* eslint-disable-next-line */
  }, deps);

  return { items, setItems, loading, reload };
}

/** 异步动作：统一 busy 状态、成功/失败 toast，页面不再各写一遍 try/catch。 */
export function useAsyncAction() {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(key);
    try {
      const result = await fn();
      if (success) toast(success, 'ok');
      return result;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
      return undefined;
    } finally {
      setBusy(null);
    }
  }, [toast]);
  return { busy, run };
}
