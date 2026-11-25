import { useEffect, useState } from 'react';

/**
 * 界面外观偏好：明暗主题 + 导航布局。
 * 只存本机 localStorage，不写入主进程设置，不影响游戏与下载逻辑。
 */
export type NavStyle = 'side' | 'top';
export type Theme = 'light' | 'dark';

const NAV_KEY = 'mcl:nav';
const THEME_KEY = 'mcl:theme';
const EVENT = 'mcl:prefs-changed';

export function getNav(): NavStyle {
  return localStorage.getItem(NAV_KEY) === 'top' ? 'top' : 'side';
}

export function getTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
}

export function applyPrefs(): void {
  const root = document.documentElement;
  root.dataset.nav = getNav();
  root.dataset.theme = getTheme();
}

function notify(): void {
  applyPrefs();
  window.dispatchEvent(new Event(EVENT));
}

export function setNav(nav: NavStyle): void {
  localStorage.setItem(NAV_KEY, nav);
  notify();
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  notify();
}

export function usePrefs() {
  const [nav, setNavState] = useState<NavStyle>(getNav);
  const [theme, setThemeState] = useState<Theme>(getTheme);
  useEffect(() => {
    const refresh = () => {
      setNavState(getNav());
      setThemeState(getTheme());
    };
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return { nav, setNav, theme, setTheme };
}