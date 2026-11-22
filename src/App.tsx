import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ToastProvider, useToast } from './components/Toast';
import { api, on } from './lib/api';
import { Icon } from './components/Icon';
import { formatBytes } from './components/Modal';
import type { Account, LaunchState, ServerInfo } from '../electron/shared/types';
import Home from './pages/Home';
import Instances from './pages/Instances';
import Servers from './pages/Servers';
import Mods from './pages/Mods';
import Download from './pages/Download';
import Content from './pages/Content';
import Backups from './pages/Backups';
import Crash from './pages/Crash';
import Migrate from './pages/Migrate';
import Accounts from './pages/Accounts';
import Cloud from './pages/Cloud';
import Logs from './pages/Logs';
import Settings from './pages/Settings';

type PageId = 'home' | 'instances' | 'servers' | 'mods' | 'download' | 'content' | 'backups' | 'crash' | 'migrate' | 'accounts' | 'cloud' | 'logs' | 'settings';

const ICONS: Record<PageId, React.ReactNode> = {
  home: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" /></svg>,
  download: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></svg>,
  instances: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" /></svg>,
  servers: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><circle cx="7" cy="7" r=".8" fill="currentColor" /><circle cx="7" cy="17" r=".8" fill="currentColor" /><path d="M11 7h6M11 17h6" /></svg>,
  mods: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 3 8v8l9 5 9-5V8l-9-5Z" /><path d="M12 12 3 8" /><path d="M12 12l9-4" /><path d="M12 12v9" /></svg>,
  content: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="9" r="1.8" /><path d="m21 15-4.5-4.5L7 20" /></svg>,
  backups: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7a8 3 0 0 1 16 0v10a8 3 0 0 1-16 0V7Z" /><path d="M4 12a8 3 0 0 0 16 0" /></svg>,
  crash: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" /></svg>,
  migrate: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>,
  accounts: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" /></svg>,
  cloud: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5 4.5 4.5 0 0 1 17.5 18H7Z" /></svg>,
  logs: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M9 9h6M9 13h6M9 17h4" /></svg>,
  settings: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>,
};

const NAV: Array<{ id: PageId; label: string; section: string }> = [
  { id: 'home', label: '启动台', section: '游戏' },
  { id: 'instances', label: '实例', section: '游戏' },
  { id: 'servers', label: '服务器', section: '游戏' },
  { id: 'mods', label: '模组中心', section: '模组与资源' },
  { id: 'download', label: '资源下载', section: '模组与资源' },
  { id: 'content', label: '内容管理', section: '模组与资源' },
  { id: 'backups', label: '存档备份', section: '模组与资源' },
  { id: 'crash', label: '崩溃分析', section: '诊断与工具' },
  { id: 'migrate', label: '迁移中心', section: '诊断与工具' },
  { id: 'logs', label: '日志', section: '诊断与工具' },
  { id: 'accounts', label: '账号', section: '账号与同步' },
  { id: 'cloud', label: '云同步', section: '账号与同步' },
  { id: 'settings', label: '设置', section: '系统' },
];

function Shell() {
  const [page, setPage] = useState<PageId>('home');
  const [activeAccount, setActiveAccount] = useState<Account | null>(null);
  const [maximized, setMaximized] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const toast = useToast();
  const [launchState, setLaunchState] = useState<LaunchState>({ instanceId: null, status: 'idle' });
  const [launchProgress, setLaunchProgress] = useState<{ done: number; total: number } | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    api.accountsActive().then(setActiveAccount).catch(() => setActiveAccount(null));
    api.windowIsMaximized().then(setMaximized).catch(() => undefined);
    const off = on('accounts:microsoft-result', () => {
      api.accountsActive().then(setActiveAccount).catch(() => undefined);
    });
    return off;
  }, []);

  // 全局状态条：集中订阅启动 / 下载 / 服务端 / 更新事件，避免每个页面各做一套
  useEffect(() => {
    const offs = [
      on('launch:status', (s: LaunchState) => setLaunchState(s)),
      on('launch:progress', (p: { done: number; total: number }) => setLaunchProgress(p)),
      on('launch:exit', () => { setLaunchProgress(null); setLaunchState({ instanceId: null, status: 'exited' }); }),
      on('launch:failed', () => { setLaunchProgress(null); setLaunchState({ instanceId: null, status: 'crashed' }); }),
      on('launch:crash', () => { setLaunchProgress(null); setLaunchState({ instanceId: null, status: 'crashed' }); }),
      on('server:status', (info: ServerInfo) => setServerInfo(info)),
      on('app:updateProgress', (p: { done: number; total: number }) => setUpdateProgress(p)),
    ];
    const onUpdateDone = () => setUpdateProgress(null);
    window.addEventListener('mcl:updateDone', onUpdateDone);
    return () => { offs.forEach(f => f()); window.removeEventListener('mcl:updateDone', onUpdateDone); };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { api.accountsActive().then(setActiveAccount).catch(() => undefined); }, 15000);
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

  const status = useMemo<{ label: string; detail?: string; tone: 'idle' | 'busy' | 'ok' | 'error'; page?: PageId }>(() => {
    if (updateProgress) {
      const pct = Math.min(100, Math.round((updateProgress.done / Math.max(1, updateProgress.total)) * 100));
      return { label: '下载启动器更新', detail: `${pct}% · ${formatBytes(updateProgress.done)} / ${formatBytes(updateProgress.total)}`, tone: 'busy', page: 'settings' };
    }
    const ls = launchState.status;
    if (ls === 'crashed') return { label: '游戏异常退出', detail: launchState.message ?? undefined, tone: 'error', page: 'crash' };
    if (['preparing', 'downloading', 'launching', 'running'].includes(ls)) {
      const label = ls === 'downloading' ? '下载游戏文件' : ls === 'launching' ? '正在启动游戏' : ls === 'running' ? '游戏运行中' : '准备游戏…';
      const detail = launchProgress && launchProgress.total > 0
        ? `${formatBytes(launchProgress.done)} / ${formatBytes(launchProgress.total)}`
        : launchState.message ?? undefined;
      return { label, detail, tone: 'busy', page: 'home' };
    }
    const ss = serverInfo?.status;
    if (ss === 'crashed') return { label: '服务端异常退出', tone: 'error', page: 'servers' };
    if (ss && ['preparing', 'starting', 'stopping', 'running'].includes(ss)) {
      const label = ss === 'preparing' ? '安装服务端' : ss === 'starting' ? '启动服务端' : ss === 'stopping' ? '停止服务端' : '服务端运行中';
      return { label, detail: serverInfo?.name, tone: 'busy', page: 'servers' };
    }
    return { label: '就绪', tone: 'idle' };
  }, [launchState, launchProgress, serverInfo, updateProgress]);

  // 切页回到顶部（借鉴 Modrinth：进入子页面时不应保留上一页的滚动位置）
  useEffect(() => { contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }, [page]);

  const launchFail = (message: string) => toast.toast(message, 'error');

  return (
    <>
      <div className="titlebar">
        <div className="brand"><div className="logo">M</div>MCL<small>新一代我的世界启动器</small></div>
        <div className="spacer" />
        <button className="winbtn" onClick={() => api.windowMinimize().catch(() => undefined)} title="最小化">─</button>
        <button className="winbtn" onClick={() => api.windowToggleMaximize().then(setMaximized).catch(() => undefined)} title="最大化/还原">{maximized ? '❐' : '□'}</button>
        <button className="winbtn close" onClick={() => api.windowClose().catch(() => undefined)} title="关闭">✕</button>
      </div>
      <div className="statusbar">
        <span className={`status-item ${status.tone}`}><span className="dot" />{status.label}</span>
        {status.detail && <span className="faint" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.detail}</span>}
        {status.page && <button className="status-link" onClick={() => setPage(status.page!)}>查看 →</button>}
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
        <main className="content" ref={contentRef}>
          <div className="page-enter" key={page}>
            {page === 'home' && <Home onNavigate={setPage} onLaunchFail={launchFail} />}
            {page === 'instances' && <Instances />}
            {page === 'servers' && <Servers />}
            {page === 'mods' && <Mods />}
            {page === 'download' && <Download />}
            {page === 'content' && <Content />}
            {page === 'backups' && <Backups />}
            {page === 'crash' && <Crash />}
            {page === 'migrate' && <Migrate />}
            {page === 'accounts' && <Accounts />}
            {page === 'cloud' && <Cloud />}
            {page === 'logs' && <Logs />}
            {page === 'settings' && <Settings onNavigate={setPage} />}
          </div>
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
