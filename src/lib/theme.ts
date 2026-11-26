import { useEffect, useState } from 'react';

/**
 * 界面外观偏好：柔光浅色 / 深色模式。
 * 只存本机 localStorage，不写入主进程设置，不影响游戏与下载逻辑。
 */
export type Theme = 'light' | 'dark';

const THEME_KEY = 'mcl:theme';
const EVENT = 'mcl:prefs-changed';

export function getTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
}

export function applyPrefs(): void {
  document.documentElement.dataset.theme = getTheme();
}

function notify(): void {
  applyPrefs();
  window.dispatchEvent(new Event(EVENT));
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  notify();
}

export function usePrefs() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  useEffect(() => {
    const refresh = () => setThemeState(getTheme());
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return { theme, setTheme };
}