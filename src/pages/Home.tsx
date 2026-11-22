import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, on } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmModal, formatBytes, timeAgo } from '../components/Modal';
import type { AppSettings, CrashDiagnosis, InstanceInfo, LaunchState } from '../../electron/shared/types';

type Page = 'home' | 'instances' | 'servers' | 'mods' | 'content' | 'backups' | 'crash' | 'migrate' | 'accounts' | 'cloud' | 'logs' | 'settings';

const LOADER_LABEL: Record<string, string> = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };
const PRESET_LABEL: Record<string, string> = { low: '低配', standard: '标准', heavy: '大型整合包' };

function loaderKey(loader: string | null | undefined): string {
  const l = (loader ?? '').toLowerCase();
  if (l.includes('neo')) return 'neoforge';
  if (l.includes('forge')) return 'forge';
  if (l.includes('quilt')) return 'quilt';
  if (l.includes('fabric')) return 'fabric';
  return 'vanilla';
}

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
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [confirmLaunch, setConfirmLaunch] = useState<InstanceInfo | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const reload = async () => {
    try {
      const [list, account] = await Promise.all([api.instancesList(), api.accountsActive()]);
      setInstances(list);
      setAccountName(account?.name ?? null);
      setSelectedId(prev => (prev && list.some(i => i.id === prev)) ? prev : (list[0]?.id ?? null));
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.launchState().then(s => { if (s) setLaunchState(s); }).catch(() => undefined);
    api.settingsGet().then(s => { setSettings(s); settingsRef.current = s; }).catch(() => undefined);
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
      setProgress(null);
      onLaunchFail(`游戏崩溃：${d.title}`);
      if (settingsRef.current?.launch.showLogOnCrash !== false) onNavigate('crash');
      void reload();
    });
    const offExit = on('launch:exit', (e: { instanceId: string }) => {
      setProgress(null);
      void reload();
      if (e?.instanceId) {
        setLaunchState(prev => (prev.instanceId === e.instanceId ? { ...prev, status: 'exited', pid: null, progress: null } : prev));
      }
    });
    const offFail = on('launch:failed', (e: { instanceId: string; error: string }) => {
      onLaunchFail(e.error);
      setProgress(null);
      setLogs(prev => [...prev, `[mcl] 启动失败：${e.error}`]);
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

  const startLaunch = async (instance: InstanceInfo) => {
    setCrash(null);
    setLogs([]);
    setProgress(null);
    try {
      await api.launchStart(instance.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      toast.toast(message, 'error');
      onLaunchFail(message);
    }
  };

  // 单击选中、双击直接启动（PCL/HMCL 的实例行交互）
  const launchInstance = (instance: InstanceInfo) => {
    setSelectedId(instance.id);
    if (settings?.general.confirmBeforeLaunch) {
      setConfirmLaunch(instance);
      return;
    }
    void startLaunch(instance);
  };

  const doLaunch = () => { if (selected) launchInstance(selected); };
  const busy = launchState.status === 'preparing' || launchState.status === 'downloading' || launchState.status === 'launching' || launchState.status === 'running';

  const quickActions: Array<{ icon: string; title: string; hint: string; onClick: () => void }> = [
    {
      icon: '💾', title: '备份存档', hint: '打包全部世界',
      onClick: () => {
        if (!selected) { toast.toast('还没有可备份的实例', 'info'); return; }
        api.backupCreate(selected.id, '手动快速备份')
          .then(b => toast.toast(b ? `已备份（${b.worldNames.length} 个世界）` : '没有存档可备份', b ? 'ok' : 'info'))
          .catch(e => toast.toast(String(e), 'error'));
      },
    },
    { icon: '🧩', title: '模组体检', hint: '冲突与缺失依赖', onClick: () => onNavigate('mods') },
    { icon: '🎨', title: '内容管理', hint: '资源包 / 光影 / 世界', onClick: () => onNavigate('content') },
    { icon: '🖥️', title: '开服务器', hint: '一键安装与启停', onClick: () => onNavigate('servers') },
    { icon: '☁️', title: '云同步', hint: 'WebDAV / Gist', onClick: () => onNavigate('cloud') },
    { icon: '🩺', title: '崩溃分析', hint: '人话解释与修复', onClick: () => onNavigate('crash') },
    { icon: '🚚', title: '迁移中心', hint: '从其它启动器导入', onClick: () => onNavigate('migrate') },
    {
      icon: '📂', title: '打开游戏目录', hint: '存档 / 模组 / 配置',
      onClick: () => { if (selected) api.instanceOpenGameDir(selected.id).catch(e => toast.toast(String(e), 'error')); },
    },
    {
      icon: '🧹', title: '清理残余进程', hint: '解决重复启动占用',
      onClick: () => { api.launchKillResidual().then(r => toast.toast(`已清理 ${r.killed.length} 个残余进程`, 'info')).catch(e => toast.toast(String(e), 'error')); },
    },
  ];

  if (loading) {
    return <div className="empty"><div className="big">⏳</div>正在加载…</div>;
  }

  return (
    <div>
      <section className="home-hero">
        <div className="home-hero-content">
          <div className="hero-id">
            <div className="hero-logo">M</div>
            <div>
              <span className="eyebrow"><span className="status-dot" />启动台</span>
              <h2>欢迎回来，{accountName ?? '旅人'}</h2>
              <div className="hero-hint">
                {selected
                  ? <>当前：<b>{selected.name}</b> · {selected.mcVersion} · {LOADER_LABEL[loaderKey(selected.loader)]} · 上次游玩 {timeAgo(selected.lastPlayedAt)}</>
                  : '还没有实例。创建或迁移一个后即可从这里启动。'}
              </div>
            </div>
          </div>
        </div>
        <div className="hero-actions">
          <button className="launch-btn" onClick={doLaunch} disabled={busy || !selected} aria-busy={busy}>
            {busy ? <span className="btn-spinner" aria-hidden="true" /> : <span className="launch-icon">▶</span>}
            {busy ? (launchState.status === 'running' ? '游戏运行中' : '准备中…') : '启 动'}
          </button>
          {busy && launchState.status === 'downloading' && (
            <button className="btn" onClick={() => api.launchCancelDownload()
              .then(ok => toast.toast(ok ? '已发送取消下载请求' : '当前没有可取消的下载', ok ? 'info' : 'error'))
              .catch(e => toast.toast(String(e), 'error'))}>取消下载</button>
          )}
          {busy && launchState.message && <div className="muted" style={{ maxWidth: 220, fontSize: 11 }}>{launchState.message}</div>}
        </div>
        {progress && (
          <div className="hero-progress">
            <div className="progress"><div style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
            <div className="faint">已下载 {formatBytes(progress.done)} / {formatBytes(progress.total)}</div>
          </div>
        )}
      </section>

      {crash && (
        <div className="panel diagnosis high mt-lg">
          <div className="row spread" style={{ alignItems: 'flex-start' }}>
            <div><strong>⚡ {crash.title}</strong><div className="faint" style={{ marginTop: 3 }}>{crash.summary}</div></div>
            <button className="btn small" onClick={() => onNavigate('crash')}>查看并修复 →</button>
          </div>
        </div>
      )}

      <div className="home-stats">
        <div className="stat-card"><div className="stat-icon">📦</div><div><div className="k">实例</div><div className="v">{instances.length}</div><div className="d">版本隔离</div></div></div>
        <div className="stat-card"><div className="stat-icon">💾</div><div><div className="k">存档</div><div className="v">{totalSaves}</div><div className="d">自动备份</div></div></div>
        <div className="stat-card"><div className="stat-icon">🧩</div><div><div className="k">模组</div><div className="v">{totalMods}</div><div className="d">体检与更新</div></div></div>
        <div className="stat-card"><div className="stat-icon">⏱️</div><div><div className="k">游玩</div><div className="v">{Math.floor(totalPlaySeconds / 3600)}<small> 小时</small></div><div className="d">仅存本机</div></div></div>
      </div>

      <section className="home-section">
        <div className="section-head">
          <div><h2>我的实例</h2><p>单击选择，双击启动</p></div>
          <button className="btn small ghost" onClick={() => onNavigate('instances')}>管理全部 →</button>
        </div>
        {instances.length === 0 ? (
          <div className="drop-hint">
            <div style={{ fontSize: 28, marginBottom: 8 }}>📦</div>
            <div style={{ fontWeight: 700 }}>还没有任何实例</div>
            <div className="faint mt">创建第一个实例，或从 HMCL / PCL2 / Prism 迁移过来</div>
            <div className="row mt-lg" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => onNavigate('instances')}>创建实例</button>
              <button className="btn" onClick={() => onNavigate('migrate')}>从其它启动器迁移</button>
            </div>
          </div>
        ) : (
          <div className="instance-rows">
            {instances.map(inst => {
              const key = loaderKey(inst.loader);
              return (
                <div
                  key={inst.id}
                  className={`instance-row ${selected?.id === inst.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(inst.id)}
                  onDoubleClick={() => launchInstance(inst)}
                  title="单击选择，双击启动"
                >
                  <div className={`row-cover loader-${key}`}>
                    <span className="cover-pill">{LOADER_LABEL[key]}</span>
                    <b>{inst.mcVersion === 'unknown' ? '?' : inst.mcVersion}</b>
                  </div>
                  <div className="row-info">
                    <div className="n" title={inst.name}>{inst.name}</div>
                    <div className="d">{inst.loaderVersion ? `${LOADER_LABEL[key]} ${inst.loaderVersion}` : LOADER_LABEL[key]} · {PRESET_LABEL[inst.memoryPreset ?? 'standard']}内存 · {timeAgo(inst.lastPlayedAt)}</div>
                  </div>
                  <div className="row-meta"><span>🧩 {inst.modsCount}</span><span>🌍 {inst.savesCount}</span></div>
                  <div className="row-actions">
                    <button className="btn small primary" title="启动" onClick={e => { e.stopPropagation(); launchInstance(inst); }}>▶</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="home-section">
        <div className="section-head"><div><h2>快捷操作</h2><p>常用入口，一步到位</p></div></div>
        <div className="quick-grid">
          {quickActions.map(action => (
            <button key={action.title} type="button" className="quick-card" onClick={action.onClick}>
              <span className="quick-icon">{action.icon}</span>
              <span><b>{action.title}</b><small>{action.hint}</small></span>
            </button>
          ))}
        </div>
      </section>

      {logs.length > 0 && (
        <section className="home-section">
          <div className="panel launch-panel">
            <div className="log-panel-head">
              <div className="panel-title" style={{ marginBottom: 0 }}>启动日志</div>
              <button className="btn small ghost" onClick={() => setShowFullLog(v => !v)}>{showFullLog ? '只看 MCL 消息' : '显示全部日志'}</button>
            </div>
            <div className="log-strip" ref={logRef}>
              {logs.filter(l => showFullLog || l.startsWith('[mcl]')).map((line, i) => {
                const cls = line.startsWith('[mcl]') ? 'mcl' : /error|exception|failed|错误/i.test(line) ? 'err' : /warn|警告/i.test(line) ? 'warn' : '';
                return <div key={i} className={`line ${cls}`}>{line}</div>;
              })}
            </div>
          </div>
        </section>
      )}

      {confirmLaunch && (
        <ConfirmModal
          title="确认启动"
          message={`即将启动实例「${confirmLaunch.name}」\n\n版本：${confirmLaunch.mcVersion} · ${confirmLaunch.loader}\n账号：${accountName ?? '未登录'}\n内存预设：${confirmLaunch.memoryPreset === 'heavy' ? '大型整合包（8G）' : confirmLaunch.memoryPreset === 'low' ? '低配（2G）' : '标准（4G）'}\n\n确认开始启动？`}
          confirmText="启动"
          onCancel={() => setConfirmLaunch(null)}
          onConfirm={() => { const target = confirmLaunch; setConfirmLaunch(null); void startLaunch(target); }}
        />
      )}
    </div>
  );
}
