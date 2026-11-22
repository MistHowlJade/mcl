import React, { useEffect, useState } from 'react';
import { Icon } from './Icon';

/**
 * 资源收藏夹（PCL CE 特色功能）：以 Modrinth projectId 为键，存在本机 localStorage。
 * 主进程零改动；Mod 搜索与资源包/光影下载两处共享同一份收藏。
 */
const KEY = 'mcl:favorites';
const EVENT = 'mcl:favorites-changed';

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function useFavorites() {
  const [ids, setIds] = useState<string[]>(read);
  useEffect(() => {
    const refresh = () => setIds(read());
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  const toggle = (id: string) => {
    const next = ids.includes(id) ? ids.filter(v => v !== id) : [...ids, id];
    localStorage.setItem(KEY, JSON.stringify(next));
    setIds(next);
    window.dispatchEvent(new Event(EVENT));
  };
  return { ids, toggle };
}

export function FavoriteButton({ id }: { id: string }) {
  const { ids, toggle } = useFavorites();
  const active = ids.includes(id);
  return (
    <button
      className={`btn small ghost favorite ${active ? 'active' : ''}`}
      onClick={() => toggle(id)}
      title={active ? '取消收藏' : '收藏资源（PCL CE 式资源收藏夹）'}
      aria-pressed={active}
    ><Icon name="star" size={14} /></button>
  );
}
