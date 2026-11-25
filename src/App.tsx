import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ToastProvider, useToast } from './components/Toast';
import { api, dropPaths, on } from './lib/api';
import { formatBytes } from './components/Modal';
import { Icon } from './components/Icon';
import { usePrefs } from './lib/theme';
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
import Tasks from './pages/Tasks';

type PageId = 'home' | 'instances' | 'servers' | 'mods' | 'download' | 'tasks' | 'content' | 'backups' | 'crash' | 'migrate' | 'accounts' | 'cloud' | 'logs' | 'settings';

const ICONS: Record<PageId, React.ReactNode> = {
  home: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" /></svg>,
  download: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M4 20h16" /></svg>,
  tasks: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h10M4 12h10M4 18h6" /><path d="m16 15 2 2 3-4" /></svg>,
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
  { id: 'tasks', label: '下载任务', section: '模组与资源' },
  { id: 'content', label: '内容管理', section: '模组与资源' },
  { id: 'backups', label: '存档备份', section: '模组与资源' },
  { id: 'crash', label: '崩溃分析', section: '诊断与工具' },
  { id: 'migrate', label: '迁移中心', section: '诊断与工具' },
  { id: 'logs', label: '日志', section: '诊断与工具' },
  { id: 'accounts', label: '账号', section: '账号与同步' },
  { id: 'cloud', label: '云同步', section: '账号与同步' },
  { id: 'settings', label: '设置', section: '系统' },
];

function LogoMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="2" y="3" width="3" height="10" />
      <rect x="11" y="3" width="3" height="10" />
      <rect x="5" y="5" width="2" height="3" />
      <rect x="9" y="5" width="2" height="3" />
      <rect x="7" y="8" width="2" height="3" />
    </svg>
  );
}

type CommandItem = { id: string; label: string; group: string; hint?: string; run: () => void };

function CommandPalette({ open, onClose, onNavigate, onLaunch, onBackup, onOpenDir, theme, toggleTheme }: {
  open: boolean;
  onClose: () => void;
  onNavigate: (p: PageId) => void;
  onLaunch: () => void;
  onBackup: () => void;
  onOpenDir: () => void;
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo<CommandItem[]>(() => [
    ...NAV.map(item => ({
      id: `nav:${item.id}`,
      label: item.label,
      group: item.section,
      hint: '页面',
      run: () => onNavigate(item.id),
    })),
    { id: 'action:launch', label: '启动当前实例', group: '操作', hint: 'Ctrl ↵', run: onLaunch },
    { id: 'action:backup', label: '备份当前实例的存档', group: '操作', run: onBackup },
    { id: 'action:dir', label: '打开当前实例的游戏目录', group: '操作', run: onOpenDir },
    { id: 'action:theme', label: theme === 'light' ? '切换到夜炉（深色）' : '切换到纸墨（浅色）', group: '外观', run: toggleTheme },
  ], [onNavigate, onLaunch, onBackup, onOpenDir, theme, toggleTheme]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter(i => `${i.label} ${i.group}`.toLowerCase().includes(q)) : items;
  }, [items, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => { setIndex(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const active = Math.min(index, Math.max(0, filtered.length - 1));

  return createPortal(
    <div className="command-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="command" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="command-search">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索页面或操作…"
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => Math.min(filtered.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); filtered[active]?.run(); onClose(); }
            }}
          />
          <kbd>ESC</kbd>
        </div>
        <div className="command-list">
          {filtered.length === 0 && <div className="command-empty">没有匹配的页面或操作</div>}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              className={`command-item ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => { item.run(); onClose(); }}
            >
              <span className="command-label">{item.label}</span>
              <span className="command-group">{item.group}</span>
              {item.hint && <span className="command-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
        <div className="command-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Shell() {
  const [page, setPage] = useState<PageId>('home');
  const [activeAccount, setActiveAccount] = useState<Account | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
  const toast = useToast();
  const { theme, setTheme } = usePrefs();
  const [launchState, setLaunchState] = useState<LaunchState>({ instanceId: null, status: 'idle' });
  const [launchProgress, setLaunchProgress] = useState<{ done: number; total: number } | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ done: number; total: number } | null>(null);
  const [modpackDrag, setModpackDrag] = useState(false);

  useEffect(() => {
    api.accountsActive().then(setActiveAccount).catch(() => setActiveAccount(null));
    api.windowIsMaximized().then(setMaximized).catch(() => undefined);
    api.appInfo().then(info => setAppVersion(info.version)).catch(() => undefined);
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

  /* 全局快捷键：Ctrl+K 命令面板、Ctrl+Enter 启动当前实例、Alt+1~9 切页 */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(v => !v);
        return;
      }
      if (mod && e.key === 'Enter') {
        e.preventDefault();
        const id = localStorage.getItem('mcl:selectedInstance');
        const start = (target: string) => api.launchStart(target).catch(err => toast.toast(err instanceof Error ? err.message : String(err), 'error'));
        if (id) void start(id);
        else void api.instancesList().then(list => { if (list[0]) void start(list[0].id); }).catch(() => undefined);
        return;
      }
      if (!typing && e.altKey && !mod && /^[1-9]$/.test(e.key)) {
        const target = NAV[Number(e.key) - 1];
        if (target) { e.preventDefault(); setPage(target.id); }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toast]);

  /* 全局拖入整合包：.mrpack / .zip 直接导入成实例。内容管理页有自己的拖放区，跳过它 */
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const isLocalDrop = (e: DragEvent) => !!(e.target as HTMLElement | null)?.closest?.('[data-mcl-local-drop]');
    const onDragEnter = (e: DragEvent) => { if (hasFiles(e) && !isLocalDrop(e)) setModpackDrag(true); };
    const onDragLeave = (e: DragEvent) => { if (!e.relatedTarget) setModpackDrag(false); };
    const onDragOver = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const onDrop = async (e: DragEvent) => {
      setModpackDrag(false);
      if (!e.dataTransfer?.files?.length) return;
      if (hasFiles(e)) e.preventDefault();
      if (isLocalDrop(e)) return;
      const filePath = dropPaths(e.dataTransfer.files).find(p => /\.(mrpack|zip)$/i.test(p));
      if (!filePath) return;
      e.preventDefault();
      try {
        const result = await api.modpackImportFile(filePath);
        const warnings = Array.isArray(result?.warnings) ? result.warnings.length : 0;
        toast.toast(result?.instanceId
          ? (warnings ? `整合包已导入，但有 ${warnings} 条提示，请到「日志」页查看` : '整合包已导入并创建新实例')
          : '整合包已处理，详情请到「日志」页查看', warnings ? 'info' : 'ok');
      } catch (err) {
        toast.toast(err instanceof Error ? err.message : String(err), 'error');
      }
    };
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [toast]);

  const sections = useMemo(() => {
    const map = new Map<string, typeof NAV>();
    for (const item of NAV) {
      const list = map.get(item.section) ?? [];
      list.push(item);
      map.set(item.section, list);
    }
    return [...map.entries()];
  }, []);

  const selectedInstanceId = () => localStorage.getItem('mcl:selectedInstance');

  const paletteLaunch = () => {
    const id = selectedInstanceId();
    const start = (target: string) => api.launchStart(target).catch(err => toast.toast(err instanceof Error ? err.message : String(err), 'error'));
    if (id) void start(id);
    else void api.instancesList().then(list => { if (list[0]) void start(list[0].id); }).catch(() => undefined);
  };

  const paletteBackup = () => {
    const id = selectedInstanceId();
    if (!id) { toast.toast('先创建一个实例再备份', 'info'); return; }
    api.backupCreate(id, '手动快速备份')
      .then(b => toast.toast(b ? `已备份（${b.worldNames.length} 个世界）` : '这个实例还没有存档', b ? 'ok' : 'info'))
      .catch(err => toast.toast(String(err), 'error'));
  };

  const paletteOpenDir = () => {
    const id = selectedInstanceId();
    if (!id) { toast.toast('先创建一个实例', 'info'); return; }
    api.instanceOpenGameDir(id).catch(err => toast.toast(String(err), 'error'));
  };

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
    return { label: '一切就绪', tone: 'idle' };
  }, [launchState, launchProgress, serverInfo, updateProgress]);

  // 切页回到顶部（进入子页面时不应保留上一页的滚动位置）
  useEffect(() => { contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); }, [page]);

  const launchFail = (message: string) => toast.toast(message, 'error');

  return (
    <>
      <div className="titlebar">
        <div className="brand">
          <div className="logo"><LogoMark /></div>
          <span className="brand-name">MCL<small>我的世界启动器</small></span>
        </div>
        <div className="titlebar-sep" />
        <button className="omnibox" onClick={() => setPaletteOpen(true)} title="打开命令面板（Ctrl K）">
          <Icon name="search" size={14} />
          <span>搜索页面与操作</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="spacer" />
        <button
          className={`status-pill ${status.tone} ${status.page ? 'link' : ''}`}
          disabled={!status.page}
          onClick={() => { if (status.page) setPage(status.page); }}
          title={status.detail ? `${status.label} · ${status.detail}` : status.label}
        >
          <span className="dot" />
          <span>{status.label}</span>
          {status.detail && <span className="status-pill-detail">{status.detail}</span>}
        </button>
        <button
          className="winbtn themebtn"
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          title={theme === 'light' ? '切换到夜炉深色' : '切换到纸墨浅色'}
          aria-label="切换明暗主题"
        >
          <Icon name={theme === 'light' ? 'moon' : 'sun'} size={14} />
        </button>
        <div className="window-controls">
          <button className="winbtn" onClick={() => api.windowMinimize().catch(() => undefined)} title="最小化" aria-label="最小化">
            <svg viewBox="0 0 24 24"><path d="M5 12h14" /></svg>
          </button>
          <button className="winbtn" onClick={() => api.windowToggleMaximize().then(setMaximized).catch(() => undefined)} title="最大化/还原" aria-label="最大化或还原">
            {maximized
              ? <svg viewBox="0 0 24 24"><rect x="7" y="7" width="12" height="12" rx="1.5" /><path d="M5 17V6a1 1 0 0 1 1-1h11" /></svg>
              : <svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg>}
          </button>
          <button className="winbtn close" onClick={() => api.windowClose().catch(() => undefined)} title="关闭" aria-label="关闭">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
      </div>
      <div className="app-shell">
        <nav className="sidebar">
          <div className="sidebar-scroll">
            {sections.map(([section, items]) => (
              <div key={section} className="rail-group">
                <div className="side-section">{section}</div>
                {items.map(item => (
                  <button
                    key={item.id}
                    className={`nav-item ${page === item.id ? 'active' : ''}`}
                    onClick={() => setPage(item.id)}
                    title={item.label}
                    aria-label={item.label}
                    aria-current={page === item.id ? 'page' : undefined}
                  >
                    <span className="icon">{ICONS[item.id]}</span>
                    <span className="nav-label">{item.label}</span>
                    {page === item.id && <span className="nav-mark" />}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className="nav-footer">
            <button
              className="rail-account"
              onClick={() => setPage('accounts')}
              title={activeAccount ? `${activeAccount.name} · 账号设置` : '未登录 · 点击登录'}
              aria-label="账号设置"
            >
              <span className="avatar">
                {activeAccount?.skinUrl
                  ? <img src={activeAccount.skinUrl} alt="" width={32} height={32} style={{ imageRendering: 'pixelated' }} />
                  : <span>{activeAccount?.name?.[0]?.toUpperCase() ?? <Icon name="accounts" size={15} />}</span>}
              </span>
              <span className="account-meta">
                <b>{activeAccount?.name ?? '未登录'}</b>
                <small>{activeAccount ? '账号已就绪' : '点击登录'}</small>
              </span>
              <span className={`rail-status ${activeAccount ? 'on' : ''}`} />
            </button>
            <div className="sidebar-meta">
              <span>v{appVersion || '0.1.0'}</span>
              <span className="dot-sep" />
              <span>数据只存本机</span>
            </div>
          </div>
        </nav>
        <main className="content" ref={contentRef}>
          <div className="page-enter" key={page}>
            {page === 'home' && <Home onNavigate={setPage} onLaunchFail={launchFail} />}
            {page === 'instances' && <Instances />}
            {page === 'servers' && <Servers />}
            {page === 'mods' && <Mods />}
            {page === 'download' && <Download />}
            {page === 'tasks' && <Tasks />}
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
      {modpackDrag && <div className="drop-overlay modpack">松开即可导入整合包（.mrpack / .zip）</div>}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={setPage}
        onLaunch={paletteLaunch}
        onBackup={paletteBackup}
        onOpenDir={paletteOpenDir}
        theme={theme}
        toggleTheme={() => setTheme(theme === 'light' ? 'dark' : 'light')}
      />
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