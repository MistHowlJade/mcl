import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, on } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmModal, formatBytes, timeAgo } from '../components/Modal';
import { Icon } from '../components/Icon';
import { PageSkeleton } from '../components/ui';
import { PixelScene } from '../components/PixelScene';
import type { Account, AppSettings, CrashDiagnosis, InstanceInfo, LaunchState, PlayStats } from '../../electron/shared/types';

type Page = 'home' | 'instances' | 'servers' | 'mods' | 'download' | 'tasks' | 'content' | 'backups' | 'crash' | 'migrate' | 'accounts' | 'cloud' | 'logs' | 'settings';

const LOADER_LABEL: Record<string, string> = { vanilla: '原版', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', quilt: 'Quilt' };
const PRESET_LABEL: Record<string, string> = { low: '低配 2G', standard: '标准 4G', heavy: '大型整合包 8G' };

function loaderKey(loader: string | null | undefined): string {
  const l = (loader ?? '').toLowerCase();
  if (l.includes('neo')) return 'neoforge';
  if (l.includes('forge')) return 'forge';
  if (l.includes('quilt')) return 'quilt';
  if (l.includes('fabric')) return 'fabric';
  return 'vanilla';
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 19) return '下午好';
  return '晚上好';
}

function todayLabel(): string {
  const d = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${week}`;
}

export default function Home({ onNavigate, onLaunchFail }: { onNavigate: (p: Page) => void; onLaunchFail: (msg: string) => void }) {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem('mcl:selectedInstance'));
  const [accountName, setAccountName] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [launchState, setLaunchState] = useState<LaunchState>({ instanceId: null, status: 'idle' });
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [crash, setCrash] = useState<CrashDiagnosis | null>(null);
  const [loading, setLoading] = useState(true);
  const [showFullLog, setShowFullLog] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [confirmLaunch, setConfirmLaunch] = useState<InstanceInfo | null>(null);
  const [stats, setStats] = useState<PlayStats | null>(null);
  const settingsRef = useRef<AppSettings | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const reload = async () => {
    try {
      const [list, account, playStats] = await Promise.all([api.instancesList(), api.accountsActive(), api.statsPlay()]);
      setInstances(list);
      setStats(playStats);
      setAccountName(account?.name ?? null);
      setAccount(account ?? null);
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

  const sortedInstances = useMemo(() => [...instances].sort((a, b) => {
    if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
    return (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt);
  }), [instances]);
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
      icon: 'save', title: '备份存档', hint: '打包全部世界',
      onClick: () => {
        if (!selected) { toast.toast('还没有可备份的实例', 'info'); return; }
        api.backupCreate(selected.id, '手动快速备份')
          .then(b => toast.toast(b ? `已备份（${b.worldNames.length} 个世界）` : '没有存档可备份', b ? 'ok' : 'info'))
          .catch(e => toast.toast(String(e), 'error'));
      },
    },
    { icon: 'download', title: '下载任务', hint: '进度与重试', onClick: () => onNavigate('tasks') },
    { icon: 'puzzle', title: '模组体检', hint: '冲突与依赖', onClick: () => onNavigate('mods') },
    { icon: 'palette', title: '内容管理', hint: '资源包 / 光影', onClick: () => onNavigate('content') },
    { icon: 'server', title: '开服务器', hint: '安装与启停', onClick: () => onNavigate('servers') },
    { icon: 'cloud', title: '云同步', hint: 'WebDAV / Gist', onClick: () => onNavigate('cloud') },
    { icon: 'health', title: '崩溃分析', hint: '人话解释与修复', onClick: () => onNavigate('crash') },
    { icon: 'migrate', title: '迁移中心', hint: '从其它启动器导入', onClick: () => onNavigate('migrate') },
    {
      icon: 'folder', title: '打开目录', hint: '存档 / 模组 / 配置',
      onClick: () => { if (selected) api.instanceOpenGameDir(selected.id).catch(e => toast.toast(String(e), 'error')); },
    },
    {
      icon: 'broom', title: '清理进程', hint: '解决重复启动占用',
      onClick: () => { api.launchKillResidual().then(r => toast.toast(`已清理 ${r.killed.length} 个残余进程`, 'info')).catch(e => toast.toast(String(e), 'error')); },
    },
  ];

  if (loading) return <PageSkeleton />;

  const weekMax = Math.max(1, ...(stats?.daily ?? []).map(d => d.seconds));
  const weekSeconds = (stats?.daily ?? []).reduce((a, d) => a + d.seconds, 0);

  return (
    <div className="dashboard">
      <header className="page-header dashboard-head">
        <div>
          <div className="kicker">{todayLabel()}</div>
          <h1>{greeting()}，{accountName ?? '旅人'}</h1>
          <p className="sub">从这里启动游戏、整理实例，或看看 MCL 帮你处理了什么。</p>
        </div>
        <div className="head-actions">
          {instances.length > 0 && (
            <button className="btn" onClick={() => onNavigate('instances')}><Icon name="grid" size={14} /> 全部实例</button>
          )}
          <button className="btn primary" onClick={() => onNavigate('instances')}><Icon name="plus" size={14} /> 新建实例</button>
        </div>
      </header>

      {crash && (
        <div className="alert danger crash-alert">
          <span className="alert-icon"><Icon name="warn" size={16} /></span>
          <div className="alert-body">
            <b>{crash.title}</b>
            <p>{crash.summary}</p>
          </div>
          <button className="btn small" onClick={() => onNavigate('crash')}>查看并修复 <Icon name="arrowRight" size={12} /></button>
        </div>
      )}

      <div className="launch-grid">
        {selected ? (
          <section className={`launch-card ${busy ? 'busy' : ''}`}>
            <div className="launch-copy">
              <div className="launch-eyebrow">
                <span className="pixel-mark" />
                当前实例
                {selected.favorite && <span className="fav-flag"><Icon name="star" size={11} /> 收藏</span>}
              </div>
              <h2 className="launch-title" title={selected.name}>
                {selected.name}
                <span className="launch-version">{selected.mcVersion}</span>
              </h2>
              <div className="launch-brandline">
                <span className={`loader-badge loader-${loaderKey(selected.loader)}`}>{LOADER_LABEL[loaderKey(selected.loader)]}</span>
                <span>{selected.loaderVersion ? `${LOADER_LABEL[loaderKey(selected.loader)]} ${selected.loaderVersion}` : '官方版本'}</span>
                <span className="dot-sep" />
                <span>{selected.modsCount} 模组 · {selected.savesCount} 存档</span>
                <span className="dot-sep" />
                <span>{PRESET_LABEL[selected.memoryPreset ?? 'standard']}</span>
              </div>

              {progress && (
                <div className="launch-progress">
                  <div className="progress"><div style={{ width: `${Math.min(100, (progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
                  <div className="progress-copy">
                    <span>正在下载游戏文件</span>
                    <span className="mono">{formatBytes(progress.done)} / {formatBytes(progress.total)}</span>
                  </div>
                </div>
              )}

              <div className="launch-specs">
                <div><span className="micro">Java</span><b>{selected.javaPath ? '指定路径' : '自动匹配'}</b></div>
                <div><span className="micro">内存</span><b>{PRESET_LABEL[selected.memoryPreset ?? 'standard']}</b></div>
                <div><span className="micro">上次游玩</span><b>{timeAgo(selected.lastPlayedAt)}</b></div>
              </div>

              <div className="launch-actions">
                <button className="launch-primary" onClick={doLaunch} disabled={busy} aria-busy={busy}>
                  <span className="launch-primary-icon">
                    {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="play" size={13} />}
                  </span>
                  <span className="launch-primary-label">
                    {busy ? (launchState.status === 'running' ? '游戏运行中' : launchState.status === 'downloading' ? '正在下载' : '准备启动…') : '启动游戏'}
                  </span>
                  {!busy && <kbd>Ctrl ↵</kbd>}
                </button>
                <button className="btn" onClick={() => onNavigate('instances')}>实例设置</button>
                <button className="btn ghost" onClick={() => { if (selected) api.instanceOpenGameDir(selected.id).catch(e => toast.toast(String(e), 'error')); }}>
                  <Icon name="folder" size={14} /> 打开目录
                </button>
                {busy && launchState.status === 'downloading' && (
                  <button className="btn ghost" onClick={() => api.launchCancelDownload()
                    .then(ok => toast.toast(ok ? '已发送取消下载请求' : '当前没有可取消的下载', ok ? 'info' : 'error'))
                    .catch(e => toast.toast(String(e), 'error'))}>取消下载</button>
                )}
              </div>

              {busy && launchState.message && <div className="launch-status-note">{launchState.message}</div>}
            </div>
            <div className="launch-art">
              <PixelScene />
              <span className="launch-art-tag">世界已就绪</span>
            </div>
          </section>
        ) : (
          <section className="launch-card empty-launch">
            <div className="launch-copy">
              <div className="launch-eyebrow"><span className="pixel-mark" /> 第一次使用</div>
              <h2 className="launch-title">先造一个属于你的世界</h2>
              <p className="launch-lead">创建实例只需要选一个版本。MCL 会自动准备 Java、下载游戏文件，并在启动前备份存档。</p>
              <div className="launch-actions">
                <button className="launch-primary" onClick={() => onNavigate('instances')}>
                  <span className="launch-primary-icon"><Icon name="plus" size={13} /></span>
                  <span className="launch-primary-label">创建实例</span>
                </button>
                <button className="btn" onClick={() => onNavigate('migrate')}>从其它启动器迁移</button>
              </div>
            </div>
            <div className="launch-art"><PixelScene /></div>
          </section>
        )}

        <aside className="home-side">
          <section className="panel account-card">
            <div className="account-head">
              <span className="account-avatar">
                {account?.skinUrl
                  ? <img src={account.skinUrl} alt="" />
                  : accountName
                    ? <span>{accountName[0]?.toUpperCase()}</span>
                    : <Icon name="accounts" size={18} />}
              </span>
              <div className="account-copy">
                <span className="micro">{accountName ? '当前账号' : '账号'}</span>
                <b>{accountName ?? '未登录'}</b>
              </div>
              <span className={`presence ${accountName ? 'on' : ''}`} title={accountName ? '已就绪' : '未登录'} />
            </div>
            <p className="account-note">
              {accountName ? '启动游戏时会自动使用这个账号，皮肤与披风随账号同步。' : '登录微软账号后可以加入正版服务器；也可以先用离线账号。'}
            </p>
            <button className="btn small block" onClick={() => onNavigate('accounts')}>
              {accountName ? '管理账号' : '登录 / 添加账号'} <Icon name="arrowRight" size={12} />
            </button>
          </section>

          <section className="panel week-card">
            <div className="week-head">
              <div>
                <span className="micro">最近 7 天</span>
                <div className="week-total"><b>{Math.round((weekSeconds || totalPlaySeconds) / 3600)}</b><span>小时</span></div>
              </div>
              <span className="week-sessions">{stats?.sessions ?? 0} 次启动</span>
            </div>
            <div className="week-bars" aria-hidden="true">
              {(stats?.daily ?? []).map(d => (
                <span key={d.date} className={`week-bar ${d.seconds > 0 ? 'has' : ''}`} style={{ height: `${Math.max(6, Math.round((d.seconds / weekMax) * 100))}%` }} title={`${d.date}：${Math.floor(d.seconds / 60)} 分钟`} />
              ))}
              {!stats?.daily?.length && <span className="week-empty">还没有游玩记录</span>}
            </div>
            {stats?.perInstance?.length ? (
              <div className="week-top">
                <span className="micro">玩得最久</span>
                <b title={stats.perInstance[0].name}>{stats.perInstance[0].name}</b>
                <span className="mono">{(stats.perInstance[0].seconds / 3600).toFixed(1)} h</span>
              </div>
            ) : null}
          </section>
        </aside>
      </div>

      <div className="metric-strip">
        <div className="metric"><span className="micro">实例</span><b>{instances.length}</b><span className="metric-unit">个独立目录</span></div>
        <div className="metric"><span className="micro">存档</span><b>{totalSaves}</b><span className="metric-unit">份自动备份</span></div>
        <div className="metric"><span className="micro">模组</span><b>{totalMods}</b><span className="metric-unit">可一键体检</span></div>
        <div className="metric"><span className="micro">总游玩</span><b>{Math.floor(totalPlaySeconds / 3600)}</b><span className="metric-unit">小时 · 仅存本机</span></div>
      </div>

      <section className="home-block">
        <div className="block-head">
          <div>
            <h2>我的实例</h2>
            <p>单击选中，双击直接启动。</p>
          </div>
          <button className="btn ghost small" onClick={() => onNavigate('instances')}>管理全部 <Icon name="arrowRight" size={12} /></button>
        </div>
        {instances.length === 0 ? (
          <div className="drop-hint">
            <div className="big"><Icon name="box" size={30} /></div>
            <div style={{ fontWeight: 700 }}>还没有任何实例</div>
            <div className="faint mt">创建第一个实例，或从 HMCL / PCL2 / Prism 迁移过来</div>
            <div className="row mt-lg" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => onNavigate('instances')}>创建实例</button>
              <button className="btn" onClick={() => onNavigate('migrate')}>从其它启动器迁移</button>
            </div>
          </div>
        ) : (
          <div className="quick-instances">
            {sortedInstances.slice(0, 4).map(inst => {
              const key = loaderKey(inst.loader);
              return (
                <div
                  key={inst.id}
                  className={`quick-instance ${selected?.id === inst.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(inst.id)}
                  onDoubleClick={() => launchInstance(inst)}
                  title="单击选中，双击启动"
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter') launchInstance(inst); if (e.key === ' ') { e.preventDefault(); setSelectedId(inst.id); } }}
                >
                  <span className={`qi-cover loader-${key}`}>
                    <b>{inst.mcVersion === 'unknown' ? '?' : inst.mcVersion}</b>
                    <small>{LOADER_LABEL[key]}</small>
                  </span>
                  <span className="qi-body">
                    <span className="qi-name" title={inst.name}>{inst.favorite && <Icon name="star" size={10} className="fav-inline" />}{inst.name}</span>
                    <span className="qi-meta">{inst.modsCount} 模组 · {inst.savesCount} 存档 · {timeAgo(inst.lastPlayedAt)}</span>
                  </span>
                  <button className="qi-play" title={`启动 ${inst.name}`} onClick={e => { e.stopPropagation(); launchInstance(inst); }}>
                    <Icon name="play" size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="home-columns">
        <section className="home-block">
          <div className="block-head">
            <div><h2>快捷入口</h2><p>常用工具，一步到位。</p></div>
          </div>
          <div className="tool-grid">
            {quickActions.map(action => (
              <button key={action.title} type="button" className="tool-tile" onClick={action.onClick}>
                <span className="tool-icon"><Icon name={action.icon} size={16} /></span>
                <span className="tool-copy"><b>{action.title}</b><small>{action.hint}</small></span>
              </button>
            ))}
          </div>
        </section>

        <section className="home-block">
          <div className="block-head">
            <div><h2>启动日志</h2><p>{logs.length ? '最近的启动输出，技术细节都在这里。' : '启动一次游戏后，这里会滚动显示日志。'}</p></div>
            {logs.length > 0 && (
              <button className="btn ghost small" onClick={() => setShowFullLog(v => !v)}>{showFullLog ? '只看 MCL' : '显示全部'}</button>
            )}
          </div>
          <div className={`console-panel ${logs.length ? '' : 'is-empty'}`}>
            {logs.length === 0 ? (
              <div className="console-empty">
                <Icon name="terminal" size={18} />
                <span>等待启动命令</span>
                <small>日志只写在本机，不会上传。</small>
              </div>
            ) : (
              <div className="log-strip" ref={logRef}>
                {logs.filter(l => showFullLog || l.startsWith('[mcl]')).map((line, i) => {
                  const cls = line.startsWith('[mcl]') ? 'mcl' : /error|exception|failed|错误/i.test(line) ? 'err' : /warn|警告/i.test(line) ? 'warn' : '';
                  return <div key={i} className={`line ${cls}`}>{line}</div>;
                })}
              </div>
            )}
          </div>
        </section>
      </div>

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