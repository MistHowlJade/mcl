import { useEffect, useState } from 'react';

/** 外观偏好只存本机，不进主进程设置（纯渲染层，不影响游戏与下载逻辑） */
export type Theme = 'aurora' | 'pcl';
export type NavStyle = 'side' | 'top';

const THEME_KEY = 'mcl:theme';
const NAV_KEY = 'mcl:nav';
const EVENT = 'mcl:prefs-changed';

export function getTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'pcl' ? 'pcl' : 'aurora';
}
export function getNav(): NavStyle {
  return localStorage.getItem(NAV_KEY) === 'top' ? 'top' : 'side';
}

export function applyPrefs(): void {
  document.documentElement.dataset.theme = getTheme();
  document.documentElement.dataset.nav = getNav();
}

function notify(): void {
  applyPrefs();
  window.dispatchEvent(new Event(EVENT));
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(THEME_KEY, theme);
  notify();
}
export function setNav(nav: NavStyle): void {
  localStorage.setItem(NAV_KEY, nav);
  notify();
}

export function usePrefs() {
  const [theme, setThemeState] = useState<Theme>(getTheme);
  const [nav, setNavState] = useState<NavStyle>(getNav);
  useEffect(() => {
    const refresh = () => { setThemeState(getTheme()); setNavState(getNav()); };
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(EVENT, refresh); window.removeEventListener('storage', refresh); };
  }, []);
  return { theme, nav, setTheme, setNav };
}
