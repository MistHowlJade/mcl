import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, on } from '../lib/api';
import { useToast } from '../components/Toast';
import { formatBytes, timeAgo } from '../components/Modal';
import type { CrashDiagnosis, InstanceInfo, LaunchState } from '../../electron/shared/types';

type Page = 'home' | 'instances' | 'mods' | 'backups' | 'crash' | 'migrate' | 'accounts' | 'logs' | 'settings';

export default function Home({ onNavigate, onLaunchFail }: { onNavigate: (p: Page) => void; onLaunchFail: (msg: string) => void }) {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem('mcl:selectedInstance'));
  const [accountName, setAccountName] = useState<string | null>(null);
  const [launchState, setLaunchState] = useState<LaunchState>({ instanceId: null, status: 'idle' });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [crash, setCrash] = useState<CrashDiagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [showFullLog, setShowFullLog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const reload = async () => {
    const [list, account] = await Promise.all([api.instancesList(), api.accountsActive()]);
    setInstances(list);
    setAccountName(account?.name ?? null);
    if (!selectedId && list.length > 0) setSelectedId(list[0].id);
    setLoading(false);
  };

  useEffect(() => {
    // 挂载时恢复主进程里的启动状态（切走再切回来也能看到"游戏运行中"）
    api.launchState().then(s => { if (s) setLaunchState(s); }).catch(() => undefined);
    void reload();
    /* eslint-disable-next-line */
  }, []);

  useEffect(() => {
    if (selectedId) localStorage.setItem('mcl:selectedInstance', selectedId);
  }, [selectedId]);

  useEffect(() => {
    const offStatus = on('launch:status', (s: LaunchState) => setLaunchState(s));
    const offProgress = on('launch:progress', (p: { done: number; total: number }) => setProgress(p));
    const offLog = on('launch:log', (line: string) => setLogs(prev => [...prev.slice(-300), line]));
    const offCrash = on('launch:crash', (d: CrashDiagnosis) => {
      setCrash(d);
      onLaunchFail(`游戏崩溃：${d.title}`);
      void reload();
    });
    const offExit = on('launch:exit', (e: { instanceId: string }) => {
      setProgress(null);
      void reload();
      if (e) setLaunchState(prev => ({ ...prev, status: 'exited' }));
    });
    const offFail = on('launch:failed', (e: { instanceId: string; error: string }) => {
      onLaunchFail(e.error);
      setProgress(null);
      setLogs(prev => [...prev, `[mcl] 启动失败：${e.error}`]);
      setLaunchState(prev => ({ ...prev, status: 'idle', message: e.error }));
    });
    return () => { [offStatus, offProgress, offLog, offCrash, offExit, offFail].forEach(f => f()); };
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const selected = useMemo(() => instances.find(i => i.id === selectedId) ?? instances[0] ?? null, [instances, selectedId]);

  const totalSaves = instances.reduce((a, i) => a + i.savesCount, 0);
  const totalMods = instances.reduce((a, i) => a + i.modsCount, 0);
  const totalPlaySeconds = instances.reduce((a, i) => a + (i.playTimeSeconds ?? 0), 0);

  const doLaunch = async () => {
    if (!selected) return;
    setCrash(null);
    setLogs([]);
    setProgress(null);
    setLaunchState({ instanceId: selected.id, status: 'preparing', message: '正在准备…' });
    await api.launchStart(selected.id);
  };

  const busy = launchState.status === 'preparing' || launchState.status === 'downloading' || launchState.status === 'launching' || launchState.status === 'running';

  if (loading) {
    return <div className="empty"><div className="big">⏳</div>正在加载…</div>;
  }

  return (
    <div>
      <div className="hero">
        <h1>欢迎回来，{accountName ?? '旅人'} 👋</h1>
        <p className="tagline">隔离你的每个世界，自动适配 Java，多线程满速下载，崩溃能看懂——这就是新一代启动器该有的样子。</p>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <button className="launch-btn" onClick={doLaunch} disabled={busy || !selected}>
            {busy ? (launchState.status === 'running' ? '游戏运行中' : '准备中…') : '启 动'}
          </button>
          {busy && launchState.message && <div className="muted" style={{ maxWidth: 300 }}>{launchState.message}</div>}
        </div>
        {progress && (
          <div className="mt" style={{ maxWidth: 460 }}>
            <div className="progress"><div style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
            <div className="faint mt">已下载 {formatBytes(progress.done)} / {formatBytes(progress.total)}</div>
          </div>
        )}
        {selected && (
          <div className="hero-meta">
            <div className="item"><span className="k">实例</span><span className="v">{selected.name}</span></div>
            <div className="item"><span className="k">版本</span><span className="v">{selected.mcVersion}</span></div>
            <div className="item"><span className="k">加载器</span><span className="v">{selected.loader}</span></div>
            <div className="item"><span className="k">内存预设</span><span className="v">{selected.memoryPreset === 'heavy' ? '大型整合包' : selected.memoryPreset === 'low' ? '低配' : '标准'}</span></div>
            <div className="item"><span className="k">上次游玩</span><span className="v">{timeAgo(selected.lastPlayedAt)}</span></div>
          </div>
        )}
        {logs.length > 0 && (
          <>
            <div className="row" style={{ marginTop: 10, marginBottom: 6 }}>
              <span className="faint">启动日志</span>
              <button className="btn small ghost" onClick={() => setShowFullLog(v => !v)}>{showFullLog ? '只看 MCL 消息' : '显示全部日志'}</button>
            </div>
            <div className="log-strip" ref={logRef}>
              {logs.filter(l => showFullLog || l.startsWith('[mcl]')).map((line, i) => {
                const cls = line.startsWith('[mcl]') ? 'mcl' : /error|exception|failed|错误/i.test(line) ? 'err' : /warn|警告/i.test(line) ? 'warn' : '';
                return <div key={i} className={`line ${cls}`}>{line}</div>;
              })}
            </div>
          </>
        )}
        {crash && (
          <div className="mt" style={{ border: '1px solid rgba(242,104,104,.4)', background: 'var(--red-soft)', borderRadius: 10, padding: '10px 14px' }}>
            <div className="row spread">
              <div><strong>⚡ {crash.title}</strong><div className="faint" style={{ marginTop: 2 }}>{crash.summary}</div></div>
              <button className="btn small" onClick={() => onNavigate('crash')}>查看并修复 →</button>
            </div>
          </div>
        )}
      </div>

      <div className="stat-grid">
        <div className="stat-card"><div className="k">实例</div><div className="v">{instances.length}</div><div className="d">版本隔离，互不干扰</div></div>
        <div className="stat-card"><div className="k">存档</div><div className="v">{totalSaves}</div><div className="d">支持启动前自动备份</div></div>
        <div className="stat-card"><div className="k">已安装模组</div><div className="v">{totalMods}</div><div className="d">含体检与更新检查</div></div>
        <div className="stat-card"><div className="k">累计游玩</div><div className="v">{Math.floor(totalPlaySeconds / 3600)}<span style={{ fontSize: 14 }}> 小时</span></div><div className="d">时长统计仅保存在本机</div></div>
      </div>

      <div className="panel-title">我的实例<span className="spacer" /><button className="btn small ghost" onClick={() => onNavigate('instances')}>全部实例 →</button></div>
      {instances.length === 0 ? (
        <div className="drop-hint">
          <div style={{ fontSize: 30, marginBottom: 8 }}>📦</div>
          <div style={{ fontWeight: 700 }}>还没有任何实例</div>
          <div className="faint mt">创建第一个实例，或从 HMCL / PCL2 / Prism 迁移过来</div>
          <div className="row mt-lg" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => onNavigate('instances')}>创建实例</button>
            <button className="btn" onClick={() => onNavigate('migrate')}>从其它启动器迁移</button>
          </div>
        </div>
      ) : (
        <div className="instance-strip">
          {instances.map(inst => (
            <div
              key={inst.id}
              className={`instance-card ${selected?.id === inst.id ? 'selected' : ''}`}
              onClick={() => setSelectedId(inst.id)}
              role="button"
              tabIndex={0}
              onKeyDown={e => e.key === 'Enter' && setSelectedId(inst.id)}
            >
              <div className="mc-icon">🧱</div>
              <div className="n" title={inst.name}>{inst.name}</div>
              <div className="d">{inst.mcVersion} · {inst.loader}</div>
              <div className="d">{inst.modsCount} 模组 · {inst.savesCount} 存档</div>
            </div>
          ))}
        </div>
      )}

      <div className="panel-title mt-lg">快捷操作</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <button className="btn" onClick={() => selected && api.backupCreate(selected.id, '手动快速备份').then(b => toast.toast(b ? `已备份（${b.worldNames.length} 个世界）` : '没有存档可备份'))}>💾 备份存档</button>
        <button className="btn" onClick={() => onNavigate('mods')}>🧩 模组体检</button>
        <button className="btn" onClick={() => onNavigate('crash')}>🩺 崩溃分析</button>
        <button className="btn" onClick={() => onNavigate('migrate')}>🚚 从其它启动器迁移</button>
        <button className="btn" onClick={() => selected && api.instanceOpenGameDir(selected.id)}>📂 打开游戏目录</button>
        <button className="btn" onClick={() => { api.launchKillResidual().then(r => toast.toast(`已清理 ${r.killed.length} 个残余进程`, 'info')); }}>🧹 清理残余进程</button>
      </div>
    </div>
  );
}
