import React, { useEffect, useMemo, useState } from 'react';
import { ToastProvider, useToast } from './components/Toast';
import { api, on } from './lib/api';
import type { Account } from '../electron/shared/types';
import Home from './pages/Home';
import Instances from './pages/Instances';
import Mods from './pages/Mods';
import Backups from './pages/Backups';
import Crash from './pages/Crash';
import Migrate from './pages/Migrate';
import Accounts from './pages/Accounts';
import Logs from './pages/Logs';
import Settings from './pages/Settings';

type PageId = 'home' | 'instances' | 'mods' | 'backups' | 'crash' | 'migrate' | 'accounts' | 'logs' | 'settings';

const ICONS: Record<PageId, React.ReactNode> = {
  home: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" /></svg>,
  instances: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" /></svg>,
  mods: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 3 8v8l9 5 9-5V8l-9-5Z" /><path d="M12 12 3 8" /><path d="M12 12l9-4" /><path d="M12 12v9" /></svg>,
  backups: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7a8 3 0 0 1 16 0v10a8 3 0 0 1-16 0V7Z" /><path d="M4 12a8 3 0 0 0 16 0" /></svg>,
  crash: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></svg>,
  migrate: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>,
  accounts: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>,
  logs: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M9 9h6M9 13h6M9 17h4" /></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>,
};

const NAV: Array<{ id: PageId; label: string; section: string }> = [
  { id: 'home', label: '启动台', section: '游戏' },
  { id: 'instances', label: '实例', section: '游戏' },
  { id: 'mods', label: '模组中心', section: '内容' },
  { id: 'backups', label: '存档备份', section: '内容' },
  { id: 'crash', label: '崩溃分析', section: '内容' },
  { id: 'migrate', label: '迁移中心', section: '工具' },
  { id: 'accounts', label: '账号', section: '工具' },
  { id: 'logs', label: '日志', section: '工具' },
  { id: 'settings', label: '设置', section: '系统' },
];

function Shell() {
  const [page, setPage] = useState<PageId>('home');
  const [activeAccount, setActiveAccount] = useState<Account | null>(null);
  const [maximized, setMaximized] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.accountsActive().then(setActiveAccount).catch(() => setActiveAccount(null));
    api.windowIsMaximized().then(setMaximized).catch(() => undefined);
    const off = on('accounts:microsoft-result', () => {
      api.accountsActive().then(setActiveAccount).catch(() => undefined);
    });
    return off;
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { api.accountsActive().then(setActiveAccount).catch(() => undefined); }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const sections = useMemo(() => {
    const map = new Map<string, typeof NAV>();
    for (const item of NAV) {
      const list = map.get(item.section) ?? [];
      list.push(item);
      map.set(item.section, list);
    }
    return [...map.entries()];
  }, []);

  const launchFail = (message: string) => toast.toast(message, 'error');

  return (
    <>
      <div className="titlebar">
        <div className="brand"><div className="logo">M</div>MCL<span className="faint">新一代我的世界启动器</span></div>
        <div className="spacer" />
        <button className="winbtn" onClick={() => api.windowMinimize()} title="最小化">─</button>
        <button className="winbtn" onClick={async () => setMaximized(await api.windowToggleMaximize())} title="最大化/还原">{maximized ? '❐' : '□'}</button>
        <button className="winbtn close" onClick={() => api.windowClose()} title="关闭">✕</button>
      </div>
      <div className="app-shell">
        <nav className="sidebar">
          {sections.map(([section, items]) => (
            <div key={section}>
              <div className="side-section">{section}</div>
              {items.map(item => (
                <button
                  key={item.id}
                  className={`nav-item ${page === item.id ? 'active' : ''}`}
                  onClick={() => setPage(item.id)}
                >
                  <span className="icon">{ICONS[item.id]}</span>
                  {item.label}
                </button>
              ))}
            </div>
          ))}
          <div className="nav-footer">
            <button className="account-chip" onClick={() => setPage('accounts')} title="管理账号">
              <div className="avatar">
                {activeAccount?.skinUrl
                  ? <img src={activeAccount.skinUrl} alt="" width={32} height={32} style={{ imageRendering: 'pixelated' }} />
                  : <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', background: 'linear-gradient(135deg,#3b5a78,#22364e)', color: '#8fd0ff', fontWeight: 800 }}>{activeAccount?.name?.[0]?.toUpperCase() ?? '?'}</div>}
              </div>
              <div className="meta">
                <div className="n">{activeAccount?.name ?? '未登录'}</div>
                <div className="t">{activeAccount ? (activeAccount.type === 'microsoft' ? '微软账号' : '离线账号') : '点击登录/创建'}</div>
              </div>
            </button>
            <div className="trust-note">开源 · 零遥测 · 令牌仅存本机<br />游戏本体仅从 Mojang 官方渠道获取</div>
          </div>
        </nav>
        <main className="content">
          {page === 'home' && <Home onNavigate={setPage} onLaunchFail={launchFail} />}
          {page === 'instances' && <Instances />}
          {page === 'mods' && <Mods />}
          {page === 'backups' && <Backups />}
          {page === 'crash' && <Crash />}
          {page === 'migrate' && <Migrate />}
          {page === 'accounts' && <Accounts />}
          {page === 'logs' && <Logs />}
          {page === 'settings' && <Settings />}
        </main>
      </div>
    </>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}
