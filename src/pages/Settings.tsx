import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmModal, Tip, Toggle, formatBytes } from '../components/Modal';
import type { AppSettings, JavaInfo, UpdateInfo } from '../../electron/shared/types';

export default function Settings({ onNavigate }: { onNavigate?: (page: 'cloud') => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [javas, setJavas] = useState<JavaInfo[]>([]);
  const [javaScanning, setJavaScanning] = useState(false);
  const [mirrorLatency, setMirrorLatency] = useState<Array<{ source: string; latencyMs: number; ok: boolean }> | null>(null);
  const [mirrorTesting, setMirrorTesting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [appVersion, setAppVersion] = useState('0.1.0');
  const [dataDir, setDataDir] = useState('');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<{ sizeBytes: number; files: number } | null>(null);
  const [cacheClearing, setCacheClearing] = useState(false);
  const [confirmClearCache, setConfirmClearCache] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.settingsGet().then(setSettings).catch(e => toast.toast(String(e), 'error'));
    api.appInfo().then(info => { setAppVersion(info.version); setDataDir(info.dataDir); }).catch(() => undefined);
    api.appCacheInfo().then(setCacheInfo).catch(() => undefined);
    scanJava();
    /* eslint-disable-next-line */
  }, []);

  const scanJava = async () => {
    setJavaScanning(true);
    try { setJavas(await api.javaDetect()); } catch { setJavas([]); } finally { setJavaScanning(false); }
  };

  const patch = async (p: any) => {
    try { setSettings(await api.settingsUpdate(p)); } catch (e) { toast.toast(String(e), 'error'); }
  };

  if (!settings) return <div className="empty"><div className="big">⚙️</div>正在加载设置…</div>;

  const testMirror = async () => {
    setMirrorTesting(true);
    try {
      const result = await api.mirrorTest();
      setMirrorLatency(result.latencies);
      toast.toast(`测速完成，推荐：${result.source === 'bmclapi' ? 'BMCLAPI（国内镜像）' : '官方源'}`, 'info');
    } catch (e) { toast.toast(String(e), 'error'); } finally { setMirrorTesting(false); }
  };

  const checkUpdate = async () => {
    setUpdateChecking(true);
    setUpdateInfo(null);
    try {
      const info = await api.appUpdateCheck();
      setUpdateInfo(info);
      toast.toast(info.hasUpdate ? `发现新版本 ${info.latest}` : '当前已是最新版本', info.hasUpdate ? 'ok' : 'info');
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setUpdateChecking(false); }
  };

  const clearCache = async () => {
    setConfirmClearCache(false);
    setCacheClearing(true);
    try {
      const r = await api.appClearCache();
      setCacheInfo(await api.appCacheInfo());
      toast.toast(`已清理 ${formatBytes(r.freedBytes)}（${r.removedFiles} 个临时文件）`, 'ok');
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setCacheClearing(false); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>设置</h1>
          <div className="sub">每一项都有说明——设置不该是玄学</div>
        </div>
      </div>

      {/* ========== 常规 ========== */}
      <div className="panel">
        <div className="panel-title">常规</div>
        <div className="setting-row">
          <div className="label">界面缩放<Tip text="等价于 Windows 的 DPI 设置，解决高分屏字太小/界面错位。立即生效，下次启动保持。" /></div>
          <div className="control">
            <select className="input" style={{ width: 130 }} value={settings.general.zoomFactor} onChange={e => { const v = parseFloat(e.target.value); patch({ general: { zoomFactor: v } }); api.windowSetZoom(v); }}>
              {[0.75, 1, 1.25, 1.5, 1.75, 2].map(z => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">默认游戏分辨率<Tip text="实例没有单独设置分辨率时使用。MCL 会把 --width/--height 传给游戏；全屏玩家可以保持默认。实例可在「高级设置」里覆盖。" /></div>
          <div className="control">
            <select
              className="input"
              style={{ width: 180 }}
              value={settings.general.defaultResolution ? `${settings.general.defaultResolution.width}x${settings.general.defaultResolution.height}` : 'auto'}
              onChange={e => {
                if (e.target.value === 'auto') { patch({ general: { defaultResolution: null } }); return; }
                const [w, h] = e.target.value.split('x').map(n => parseInt(n, 10));
                patch({ general: { defaultResolution: { width: w, height: h } } });
              }}
            >
              <option value="auto">不指定（交给游戏）</option>
              <option value="854x480">854 × 480</option>
              <option value="1280x720">1280 × 720（默认）</option>
              <option value="1600x900">1600 × 900</option>
              <option value="1920x1080">1920 × 1080</option>
              <option value="2560x1440">2560 × 1440</option>
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">启动前自动备份存档<Tip text="每次点击「启动」之前，自动把该实例的 saves 打包到 backups 目录。崩溃/翻车也能一键还原（痛点：存档损坏=永久丢失）。" /></div>
          <div className="control"><Toggle checked={settings.general.autoBackupBeforeLaunch} onChange={v => patch({ general: { autoBackupBeforeLaunch: v } })} label="启动前自动备份" /></div>
        </div>
        <div className="setting-row">
          <div className="label">自动备份保留份数<Tip text="只保留最近 N 份「启动前自动备份」，更旧的会被自动清理，防止 backups 目录无限膨胀。" /></div>
          <div className="control">
            <select className="input" style={{ width: 100 }} value={settings.general.backupKeep} onChange={e => patch({ general: { backupKeep: parseInt(e.target.value, 10) } })}>
              {[3, 5, 10, 20, 50].map(n => <option key={n} value={n}>{n} 份</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ========== 下载 ========== */}
      <div className="panel">
        <div className="panel-title">下载与镜像</div>
        <div className="setting-row">
          <div className="label">下载源<Tip text="自动：先用 BMCLAPI（国内镜像）下载，失败自动回退到 Mojang 官方源。国内网络强烈推荐保持「自动」。" /></div>
          <div className="control">
            <select className="input" style={{ width: 260 }} value={settings.download.source} onChange={e => patch({ download: { source: e.target.value } })}>
              <option value="auto">自动（BMCLAPI 优先，官方兜底）</option>
              <option value="bmclapi">BMCLAPI 镜像</option>
              <option value="official">Mojang 官方源</option>
              <option value="custom">自定义镜像</option>
            </select>
          </div>
        </div>
        {settings.download.source === 'custom' && (
          <div className="setting-row">
            <div className="label">自定义镜像根地址<Tip text="镜像需要兼容 piston-meta / piston-data / libraries 路径结构，如 https://your-mirror.example.com" /></div>
            <div className="control"><input className="input" placeholder="https://your-mirror.example.com" value={settings.download.customMirror} onChange={e => patch({ download: { customMirror: e.target.value } })} /></div>
          </div>
        )}
        <div className="setting-row">
          <div className="label">镜像测速<Tip text="分别测试两个源的响应时间，帮助你判断当前网络下哪个更快。" /></div>
          <div className="control">
            <button className="btn" onClick={testMirror} disabled={mirrorTesting}>{mirrorTesting ? '测速中…' : '开始测速'}</button>
          </div>
        </div>
        {mirrorLatency && (
          <div className="setting-row">
            <div className="label" />
            <div className="control" style={{ justifyContent: 'flex-start' }}>
              {mirrorLatency.map(l => (
                <span key={l.source} className={`tag ${l.latencyMs < 60000 ? (l.latencyMs < 800 ? 'green' : 'amber') : 'red'}`}>
                  {l.source === 'bmclapi' ? 'BMCLAPI' : '官方'}：{l.latencyMs >= 60000 ? '不可用' : `${l.latencyMs} ms`}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="setting-row">
          <div className="label">并发下载线程<Tip text="同时下载几个文件。16 是多数带宽下的甜点值；网速特别好可以开 32，老路由器调低防卡死。" /></div>
          <div className="control">
            <select className="input" style={{ width: 110 }} value={settings.download.maxThreads} onChange={e => patch({ download: { maxThreads: parseInt(e.target.value, 10) } })}>
              {[4, 8, 16, 24, 32, 48, 64].map(n => <option key={n} value={n}>{n} 线程</option>)}
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">分段下载阈值<Tip text="大于该体积的文件会拆成多段并发 Range 下载，充分跑满带宽（下载速度是换启动器的主因）。" /></div>
          <div className="control">
            <select className="input" style={{ width: 110 }} value={settings.download.segmentSizeMB} onChange={e => patch({ download: { segmentSizeMB: parseInt(e.target.value, 10) } })}>
              {[2, 4, 8, 16].map(n => <option key={n} value={n}>{n} MB</option>)}
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">单文件超时<Tip text="超过这个时间没有数据就判定失败并自动切换镜像重试。不要设太大，卡住时宁可早失败早换源。" /></div>
          <div className="control">
            <select className="input" style={{ width: 110 }} value={settings.download.timeoutMs} onChange={e => patch({ download: { timeoutMs: parseInt(e.target.value, 10) } })}>
              {[8000, 15000, 30000, 60000].map(n => <option key={n} value={n}>{n / 1000} 秒</option>)}
            </select>
          </div>
        </div>
        <div className="setting-row">
          <div className="label">失败重试次数<Tip text="单个文件失败后在镜像间交替重试的次数；SHA-1 校验不符也会自动重下。" /></div>
          <div className="control">
            <select className="input" style={{ width: 110 }} value={settings.download.retries} onChange={e => patch({ download: { retries: parseInt(e.target.value, 10) } })}>
              {[1, 2, 3, 5, 8].map(n => <option key={n} value={n}>{n} 次</option>)}
            </select>
          </div>
        </div>
      </div>

      {/* ========== Java ========== */}
      <div className="panel">
        <div className="panel-title">Java 环境<span className="spacer" /><button className="btn small" onClick={scanJava} disabled={javaScanning}>{javaScanning ? '检测中…' : '重新检测'}</button></div>
        <div className="setting-row">
          <div className="label">全局默认 Java<Tip text="留空 = MCL 按游戏版本自动选择（1.16.5 及以下 Java 8；1.17–1.20.4 Java 17；1.20.5+ Java 21）；该版本缺失时自动从 Adoptium 下载。实例里可单独覆盖。" /></div>
          <div className="control">
            <input className="input" style={{ maxWidth: 360 }} placeholder="留空 = 自动管理（推荐）" value={settings.java.defaultPath} onChange={e => patch({ java: { defaultPath: e.target.value } })} />
          </div>
        </div>
        {javas.length === 0 ? (
          <div className="faint">未检测到任何 Java。没关系——首次启动游戏时 MCL 会自动下载合适的版本。</div>
        ) : (
          <div className="list mt">
            {javas.map(j => (
              <div key={j.path} className="list-row">
                <span className={`tag ${j.major === 8 ? 'amber' : 'blue'}`}>Java {j.major}</span>
                {!j.is64 && <span className="tag red">32 位</span>}
                {j.major === 8 && j.version.match(/^1\.8\.0_(\d+)$/) && parseInt(j.version.match(/^1\.8\.0_(\d+)$/)![1], 10) < 291 && <span className="tag red">&lt; 8u291（TLS 1.3 受限）</span>}
                {j.managed && <span className="tag green">MCL 管理</span>}
                <div style={{ minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={j.path}>{j.path}</div>
                  <div className="faint">{j.version} · {j.vendor}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="faint mt">为什么要关心 Java 小版本？1.12.2 在 Java 8u202 上会有 LWJGL 链接问题（需要 8u51 或更新的完整支持版本）；Java 8 低于 8u291 不支持 TLS 1.3，连微软验证会失败。MCL 自动下载的版本都是当前最新补丁版，没有这些坑。</p>
      </div>

      {/* ========== 启动 ========== */}
      <div className="panel">
        <div className="panel-title">启动行为</div>
        <div className="setting-row">
          <div className="label">启动前清理残余进程<Tip text="上次崩溃后还活着的 javaw.exe 会占用存档和 natives dll，导致「明明关了游戏却提示文件被占用 / 残余进程清不掉」。开启后启动前自动 taskkill 本启动器上次启动的进程。" /></div>
          <div className="control"><Toggle checked={settings.launch.autoKillResidual} onChange={v => patch({ launch: { autoKillResidual: v } })} label="清理残余进程" /></div>
        </div>
        <div className="setting-row">
          <div className="label">1.17 以下自动附加 Log4j 缓解参数<Tip text="自动加上 -Dlog4j2.formatMsgNoLookups=true，消除 Log4Shell（CVE-2021-44228）风险。老整合包不用你自己贴参数了。" /></div>
          <div className="control"><Toggle checked={settings.launch.log4jFix} onChange={v => patch({ launch: { log4jFix: v } })} label="Log4j 缓解" /></div>
        </div>
        <div className="setting-row">
          <div className="label">强制 UTF-8 文件编码<Tip text="加上 -Dfile.encoding=UTF-8 -Dsun.jnu.encoding=UTF-8。非 UTF-8 区域设置的 Windows（中文系统常见）经常因此乱码甚至闪退。" /></div>
          <div className="control"><Toggle checked={settings.launch.utf8Encoding} onChange={v => patch({ launch: { utf8Encoding: v } })} label="UTF-8 编码" /></div>
        </div>
        <div className="setting-row">
          <div className="label">全局 JVM 参数<Tip text="对所有实例与服务端生效，每行一条或空格分隔。会追加在实例参数之后。例如 -XX:+UseG1GC 或代理参数。不确定就不要填；填错可能导致游戏无法启动。" /></div>
          <div className="control"><textarea className="input" style={{ width: '100%', maxWidth: 520, minHeight: 70 }} placeholder="例如：-XX:+UseG1GC" value={settings.launch.globalJvmArgs} onChange={e => patch({ launch: { globalJvmArgs: e.target.value } })} /></div>
        </div>
      </div>

      {/* ========== 云同步 ========== */}
      <div className="panel">
        <div className="panel-title">云同步</div>
        <div className="setting-row">
          <div className="label">当前方式<Tip text="MCL 不提供官方云服务器：用你自己的 WebDAV 或 GitHub Gist。绝不上传微软令牌、CurseForge 密钥与云同步密码。" /></div>
          <div className="control">
            <span className={`tag ${settings.cloud.provider === 'off' ? '' : 'green'}`}>
              {settings.cloud.provider === 'off' ? '未启用' : settings.cloud.provider === 'webdav' ? 'WebDAV 完整快照' : 'GitHub Gist（仅配置）'}
            </span>
            {onNavigate && <button className="btn" onClick={() => onNavigate('cloud')}>打开云同步中心 →</button>}
          </div>
        </div>
        <div className="setting-row">
          <div className="label">上次同步<Tip text="上传 / 下载的方向与时间。换电脑时：先在新电脑填同样的 WebDAV 地址或 Gist ID，再点「从云端下载」。" /></div>
          <div className="control">
            <span className="faint">{settings.cloud.lastSyncAt ? `${new Date(settings.cloud.lastSyncAt).toLocaleString()}（${settings.cloud.lastSyncDirection === 'download' ? '下载' : '上传'}）` : '还没有同步过'}</span>
          </div>
        </div>
      </div>

      {/* ========== CurseForge ========== */}
      <div className="panel">
        <div className="panel-title">CurseForge API（可选）</div>
        <div className="setting-row">
          <div className="label">API 密钥<Tip text="只用于导入 CurseForge 整合包时自动下载其中的模组。去 console.curseforge.com 免费申请，只读权限即可。密钥仅保存在本机。" /></div>
          <div className="control"><input className="input" type="password" style={{ maxWidth: 320 }} placeholder="留空 = 导入 CF 整合包时给手动下载链接" value={settings.curseforge.apiKey} onChange={e => patch({ curseforge: { apiKey: e.target.value } })} autoComplete="off" /></div>
        </div>
        <p className="faint">没有密钥也能导入：MCL 会创建好实例并复制 overrides，缺的模组给逐个手动下载链接，绝不静默失败。</p>
      </div>

      {/* ========== 更新检查 ========== */}
      <div className="panel">
        <div className="panel-title">启动器更新<span className="spacer" /><button className="btn small" onClick={checkUpdate} disabled={updateChecking}>{updateChecking ? '检查中…' : '检查更新'}</button></div>
        <div className="row" style={{ gap: 28, flexWrap: 'wrap' }}>
          <div><div className="faint">当前版本</div><div style={{ fontWeight: 800, fontSize: 18 }}>{appVersion}</div></div>
          <div><div className="faint">最新版本</div><div style={{ fontWeight: 700 }}>{updateInfo?.latest ?? '—'}</div></div>
          <div><div className="faint">状态</div><div style={{ fontWeight: 700, color: updateInfo?.hasUpdate ? 'var(--accent)' : undefined }}>{updateInfo ? (updateInfo.hasUpdate ? '有新版本可用' : '已是最新') : '尚未检查'}</div></div>
        </div>
        {updateInfo?.notes && (
          <div className="mt" style={{ maxHeight: 180, overflowY: 'auto', background: 'var(--panel-2)', borderRadius: 8, padding: '10px 12px', whiteSpace: 'pre-wrap', fontSize: 12 }}>{updateInfo.notes}</div>
        )}
        {updateInfo?.url && (
          <div className="row mt" style={{ gap: 8 }}>
            <button className="btn" onClick={() => api.openExternal(updateInfo.url!)}>打开 Release 页面 ↗</button>
            {updateInfo.publishedAt && <span className="faint">发布于 {new Date(updateInfo.publishedAt).toLocaleDateString()}</span>}
          </div>
        )}
        <p className="faint mt">MCL 不会自动下载更新，也不会在后台偷偷替换程序文件——只提示版本并交给你决定。</p>
      </div>

      {/* ========== 缓存 ========== */}
      <div className="panel">
        <div className="panel-title">存储与缓存</div>
        <div className="setting-row">
          <div className="label">数据目录<Tip text="实例、共享库、Java、备份与日志都在这里。便携模式：exe 同目录放 portable.txt 后数据会放到 exe 旁的 mcl-data/。" /></div>
          <div className="control">
            <span className="mono" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={dataDir}>{dataDir || '…'}</span>
            {dataDir && <button className="btn small" onClick={() => api.openPath(dataDir)}>打开</button>}
          </div>
        </div>
        <div className="setting-row">
          <div className="label">下载缓存<Tip text="下载过程中的 .part 断点续传文件与临时数据。清理不会删除已安装的游戏、模组或存档，只会让未完成的下载重新开始。" /></div>
          <div className="control">
            <span className="faint">{cacheInfo ? `${formatBytes(cacheInfo.sizeBytes)} · ${cacheInfo.files} 个文件` : '统计中…'}</span>
            <button className="btn small danger" disabled={cacheClearing || !cacheInfo || cacheInfo.sizeBytes === 0} onClick={() => setConfirmClearCache(true)}>{cacheClearing ? '清理中…' : '清理缓存'}</button>
          </div>
        </div>
      </div>

      {/* ========== 关于 ========== */}
      <div className="panel">
        <div className="panel-title">关于 MCL</div>
        <div className="row" style={{ gap: 32, flexWrap: 'wrap' }}>
          <div><div className="faint">版本</div><div style={{ fontWeight: 800, fontSize: 18 }}>{appVersion}</div></div>
          <div><div className="faint">协议</div><div style={{ fontWeight: 700 }}>MIT 开源</div></div>
          <div><div className="faint">遥测</div><div style={{ fontWeight: 700, color: 'var(--accent)' }}>无 · 不收集任何数据</div></div>
          <div><div className="faint">游戏本体</div><div style={{ fontWeight: 700 }}>Mojang 官方渠道（可切换镜像）</div></div>
        </div>
        <div className="row mt" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => api.openExternal('https://github.com/MistHowlJade/mcl')}>GitHub 仓库 ↗</button>
          <button className="btn" onClick={() => api.openExternal('https://github.com/MistHowlJade/mcl/issues/new')}>反馈问题 ↗</button>
          <button className="btn" onClick={() => api.diagnosticExport()}>导出诊断包</button>
          <button className="btn danger" onClick={() => setConfirmReset(true)}>重置全部设置…</button>
        </div>
      </div>

      {confirmReset && (
        <ConfirmModal
          title="重置全部设置"
          message="会把所有设置恢复为默认值（实例、存档、账号不受影响）。确定继续？"
          confirmText="重置"
          danger
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => { api.settingsReset().then(setSettings).then(() => toast.toast('设置已重置')); setConfirmReset(false); }}
        />
      )}

      {confirmClearCache && (
        <ConfirmModal
          title="清理下载缓存"
          message={`将删除数据目录 cache/ 下的 ${cacheInfo?.files ?? 0} 个临时文件（${formatBytes(cacheInfo?.sizeBytes ?? 0)}）。\n\n已安装的游戏、模组、存档、Java 不受影响；未完成的下载会需要重新开始。确定继续？`}
          confirmText="清理"
          danger
          onCancel={() => setConfirmClearCache(false)}
          onConfirm={clearCache}
        />
      )}
    </div>
  );
}
