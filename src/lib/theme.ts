import { useEffect, useState } from 'react';

/**
 * 导航样式偏好（深色游戏库为唯一设计系统，不提供明暗切换）
 * 只存本机，不进主进程设置，不影响游戏与下载逻辑。
 */
export type NavStyle = 'side' | 'top';

const NAV_KEY = 'mcl:nav';
const EVENT = 'mcl:prefs-changed';

export function getNav(): NavStyle {
  return localStorage.getItem(NAV_KEY) === 'top' ? 'top' : 'side';
}

export function applyPrefs(): void {
  document.documentElement.dataset.nav = getNav();
}

function notify(): void {
  applyPrefs();
  window.dispatchEvent(new Event(EVENT));
}

export function setNav(nav: NavStyle): void {
  localStorage.setItem(NAV_KEY, nav);
  notify();
}

export function usePrefs() {
  const [nav, setNavState] = useState<NavStyle>(getNav);
  useEffect(() => {
    const refresh = () => setNavState(getNav());
    window.addEventListener(EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return { nav, setNav };
}
