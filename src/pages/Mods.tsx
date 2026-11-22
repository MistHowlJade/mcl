import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, on } from '../lib/api';
import { useToast } from '../components/Toast';
import { Modal, Tip, formatBytes, timeAgo } from '../components/Modal';
import { FavoriteButton, useFavorites } from '../components/FavoriteButton';
import { Icon } from '../components/Icon';
import type { InstanceInfo, InstalledMod, ModHealthIssue, ModSearchResult } from '../../electron/shared/types';

type Tab = 'installed' | 'search' | 'import';

/**
 * Modrinth 搜索结果的 versions 一般按从旧到新排序，直接 slice(0, 4) 会展示最旧的四个版本，
 * 出现「按 1.20.1 搜索却显示支持 1.16.x」的误导。优先标出当前实例版本。
 */
function versionSupportLabel(versions: string[], current: string): string {
  if (!Array.isArray(versions) || versions.length === 0) return '支持版本未知';
  const hasCurrent = versions.includes(current);
  const newest = versions[versions.length - 1];
  if (hasCurrent) {
    return `支持当前 ${current}${newest && newest !== current ? ` · 最新 ${newest}` : ''} · 共 ${versions.length} 个版本`;
  }
  return newest ? `最新 ${newest} · 共 ${versions.length} 个版本` : `共 ${versions.length} 个版本`;
}

export default function Mods() {
  const [tab, setTab] = useState<Tab>('installed');
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [instanceId, setInstanceId] = useState<string | null>(() => localStorage.getItem('mcl:selectedInstance'));
  const toast = useToast();

  const reloadInstances = async (): Promise<InstanceInfo[]> => {
    try {
      const list = await api.instancesList();
      setInstances(list);
      // localStorage 里的实例可能已被删除：失效时自动落到第一台
      setInstanceId(prev => (prev && list.some(i => i.id === prev)) ? prev : (list[0]?.id ?? null));
      return list;
    } catch (e) {
      toast.toast(String(e), 'error');
      return [];
    }
  };

  useEffect(() => {
    void reloadInstances();
    /* eslint-disable-next-line */
  }, []);
  // 与首页/内容页共用同一个实例选择：切到别的页面后不应跳回旧实例
  useEffect(() => {
    if (instanceId) localStorage.setItem('mcl:selectedInstance', instanceId);
  }, [instanceId]);
  const instance = useMemo(() => instances.find(i => i.id === instanceId) ?? null, [instances, instanceId]);

  if (instances.length === 0) {
    return (
      <div>
        <div className="page-header"><div><h1>模组中心</h1><div className="sub">需要先有一个实例</div></div></div>
        <div className="empty"><div className="big"><Icon name="puzzle" size={30} /></div>还没有实例。先在「实例」页创建一个，再来装模组。</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>模组中心</h1>
          <div className="sub">Modrinth 直装 · 模组体检 · 整合包导入 · 更新检查（尊重"禁止自动更新"）</div>
        </div>
        <div className="row">
          <span className="faint">实例</span>
          <select className="input" style={{ width: 'auto' }} value={instanceId ?? ''} onChange={e => setInstanceId(e.target.value)}>
            {instances.map(i => <option key={i.id} value={i.id}>{i.name}（{i.mcVersion} {i.loader}）</option>)}
          </select>
        </div>
      </div>

      <div className="row" style={{ gap: 6, marginBottom: 16 }}>
        {([['installed', '已安装'], ['search', '搜索 Modrinth'], ['import', '导入整合包']] as Array<[Tab, string]>).map(([id, label]) => (
          <button key={id} className={`btn ${tab === id ? 'primary' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      {tab === 'installed' && instance && <InstalledTab instance={instance} />}
      {tab === 'search' && instance && <SearchTab instance={instance} />}
      {tab === 'import' && <ImportTab onImported={id => { void reloadInstances().then(() => setInstanceId(id)); }} />}
    </div>
  );
}

function InstalledTab({ instance }: { instance: InstanceInfo }) {
  const [mods, setMods] = useState<InstalledMod[]>([]);
  const [checking, setChecking] = useState(false);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [healthReport, setHealthReport] = useState<{ scanned: number; issues: ModHealthIssue[] } | null>(null);
  const toast = useToast();
  const reloadSeq = useRef(0);
  const instanceRef = useRef(instance.id);
  const reload = async () => {
    const seq = ++reloadSeq.current;
    try {
      const list = await api.modrinthInstalled(instance.id);
      if (seq === reloadSeq.current && instanceRef.current === instance.id) setMods(list);
    } catch (e) {
      if (seq === reloadSeq.current) toast.toast(String(e), 'error');
    }
  };
  useEffect(() => {
    instanceRef.current = instance.id;
    reloadSeq.current++;              // 让上一个实例还没返回的请求作废
    setMods([]);
    setHealthReport(null);
    // 上一个实例的“检查更新/更新中”状态不能带到新实例，否则按钮会一直禁用
    setChecking(false);
    setUpdatingAll(false);
    setPending(null);
    void reload();
    /* eslint-disable-next-line */
  }, [instance.id]);

  const checkHealth = async () => {
    const id = instance.id;
    setHealthReport(null);
    try {
      const report = await api.modsHealth(id);
      if (instanceRef.current !== id) return;
      setHealthReport(report);
      if (report.issues.length === 0) toast.toast(`体检通过：扫描 ${report.scanned} 个模组，没有发现异常`);
    } catch (e) { toast.toast(String(e), 'error'); }
  };

  const checkUpdates = async () => {
    const id = instance.id;
    setChecking(true);
    try {
      // 开关开启时也要走一次服务层：它会清掉之前缓存的「可更新」标记，
      // 否则界面会一直残留旧提示，诱导玩家去点更新。
      const result = await api.modrinthCheckUpdates(id, instance.mcVersion, instance.loader === 'vanilla' ? undefined : instance.loader);
      if (instanceRef.current !== id) return;
      setMods(result);
      if (instance.noModUpdate) {
        toast.toast('该实例已开启「禁止 Mod 自动更新」，已清除更新提示', 'info');
        return;
      }
      const n = result.filter(m => m.updateAvailable).length;
      toast.toast(n > 0 ? `有 ${n} 个模组可更新` : '所有模组都是最新版本');
    } catch (e) { toast.toast(String(e), 'error'); } finally { if (instanceRef.current === id) setChecking(false); }
  };

  const applyFix = async (issue: ModHealthIssue) => {
    if (!issue.fix?.target) return;
    try {
      const ok = await api.modsHealthFix(instance.id, issue.fix.target);
      // 失败时保留问题条目：否则界面把问题划掉了，但文件其实还在，用户以为已经修好
      if (!ok) {
        toast.toast('修复失败：文件可能已被改动或存在同名 .disabled，请重新体检', 'error');
        return;
      }
      toast.toast('已隔离（重命名为 .disabled），可随时手动改回', 'ok');
      setHealthReport(prev => prev ? { ...prev, issues: prev.issues.filter(i => i !== issue) } : prev);
      void reload();
    } catch (e) { toast.toast(String(e), 'error'); }
  };

  const updateMod = async (mod: InstalledMod) => {
    if (pending) return;
    const id = instance.id;
    setPending(`update:${mod.fileName}`);
    try {
      await api.modrinthUpdateMod(id, mod.fileName);
      toast.toast(`已更新 ${mod.title ?? mod.fileName}`, 'ok');
      if (instanceRef.current === id) await reload();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { if (instanceRef.current === id) setPending(null); }
  };

  const updateAll = async () => {
    if (updatingAll) return;
    const id = instance.id;
    const targets = mods.filter(m => m.updateAvailable);
    if (targets.length === 0) return;
    setUpdatingAll(true);
    setPending('batch');
    let ok = 0;
    let fail = 0;
    for (const mod of targets) {
      if (instanceRef.current !== id) break;
      try { await api.modrinthUpdateMod(id, mod.fileName); ok++; }
      catch { fail++; }
    }
    if (instanceRef.current === id) await reload();
    setUpdatingAll(false);
    setPending(null);
    toast.toast(`批量更新完成：成功 ${ok} 个${fail ? `，失败 ${fail} 个` : ''}`, fail ? 'error' : 'ok');
  };

  const toggleMod = async (mod: InstalledMod) => {
    if (pending) return;
    const id = instance.id;
    setPending(`toggle:${mod.fileName}`);
    try {
      await api.modrinthToggle(id, mod.fileName);
      if (instanceRef.current === id) await reload();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { if (instanceRef.current === id) setPending(null); }
  };

  return (
    <div className="panel">
      <div className="row spread" style={{ marginBottom: 12 }}>
        <div className="panel-title" style={{ marginBottom: 0 }}>已安装 {mods.length} 个模组<span className="spacer" /></div>
        <div className="row" style={{ gap: 8 }}>
          <Tip text="体检会直接解析 mods 目录里 jar 的模组元数据（fabric.mod.json / mods.toml），检测重复、异加载器、零字节损坏文件" />
          <button className="btn small" onClick={checkHealth}><Icon name="health" size={12} /> 体检</button>
          <Tip text="检查 Modrinth 上是否有可更新版本。开启了「禁止 Mod 自动更新」的实例不会联网查询，并会清除旧的更新提示" />
          <button className="btn small" onClick={checkUpdates} disabled={checking}>{checking ? '检查中…' : '🔄 检查更新'}</button>
          <button className="btn small primary" onClick={() => void updateAll()} disabled={updatingAll || !!pending || !mods.some(m => m.updateAvailable)}>
            {updatingAll ? '更新中…' : '更新全部'}
          </button>
          <button className="btn small" onClick={() => api.modsOpenFolder(instance.id).catch(e => toast.toast(String(e), 'error'))}><Icon name="folder" size={12} /> 打开目录</button>
        </div>
      </div>
      {mods.length === 0 ? (
        <div className="empty"><div className="big"><Icon name="puzzle" size={30} /></div>还没有模组，去「搜索 Modrinth」装几个吧</div>
      ) : (
        <div className="list">
          {mods.map(mod => (
            <div key={mod.fileName} className="list-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <strong style={{ fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{mod.title ?? mod.fileName}</strong>
                  {mod.disabled && <span className="tag amber">已禁用</span>}
                  {mod.updateAvailable && <span className="tag green">可更新 → {mod.updateAvailable.versionNumber}</span>}
                </div>
                <div className="faint">{mod.versionNumber ? `v${mod.versionNumber} · ` : ''}{formatBytes(mod.sizeBytes)} · {mod.installedAt ? timeAgo(mod.installedAt) : '手动放入'} {mod.projectId ? '' : '· 未知来源（手动放入）'}</div>
              </div>
              <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                {mod.updateAvailable && (
                  <button className="btn small primary" disabled={!!pending} onClick={() => updateMod(mod)}>
                    {pending === `update:${mod.fileName}` ? '更新中…' : '更新'}
                  </button>
                )}
                <button className="btn small" disabled={!!pending} onClick={() => toggleMod(mod)}>
                  {pending === `toggle:${mod.fileName}` ? '处理中…' : (mod.disabled ? '启用' : '禁用')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {healthReport && (
        <Modal title={`模组体检报告（扫描 ${healthReport.scanned} 个）`} onClose={() => setHealthReport(null)} footer={<button className="btn primary" onClick={() => setHealthReport(null)}>知道了</button>}>
          {healthReport.issues.length === 0 ? <p className="muted">没有发现问题，mods 目录很健康。</p> : healthReport.issues.map((issue, i) => (
            <div key={i} className="fix-item">
              <div style={{ flex: 1 }}>
                <div className="fx-label">{issue.kind === 'duplicate' ? '重复模组' : issue.kind === 'zero-byte' ? '损坏文件' : issue.kind === 'foreign-loader' ? '加载器不匹配' : '异常'} · {issue.modName}</div>
                <div className="fx-desc">{issue.detail}</div>
              </div>
              {issue.fix?.action !== 'none' && <button className="btn small danger" onClick={() => applyFix(issue)}>{issue.kind === 'duplicate' ? '隔离旧版' : '隔离文件'}</button>}
            </div>
          ))}
        </Modal>
      )}
    </div>
  );
}

function SearchTab({ instance }: { instance: InstanceInfo }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<'downloads' | 'relevance' | 'follows' | 'updated'>('downloads');
  const [results, setResults] = useState<ModSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const { ids: favoriteIds } = useFavorites();
  const toast = useToast();
  const searchSeq = useRef(0);
  const loader = instance.loader === 'vanilla' ? undefined : instance.loader;

  useEffect(() => {
    // 切换实例后旧实例的搜索结果/安装状态不再适用
    searchSeq.current++;
    setResults([]);
    setSearching(false);
    setInstalling(null);
  }, [instance.id]);

  const search = async () => {
    if (!query.trim()) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    try {
      const list = await api.modrinthSearch(query.trim(), { loader, gameVersion: instance.mcVersion, index });
      if (seq === searchSeq.current) setResults(list);
    } catch (e) {
      if (seq === searchSeq.current) toast.toast(`搜索失败：${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  };

  const install = async (r: ModSearchResult) => {
    if (installing) return;
    setInstalling(r.projectId);
    try {
      const result = await api.modrinthInstall(instance.id, r.projectId, null, { loader, gameVersion: instance.mcVersion });
      const deps = result.installed.length - 1;
      toast.toast(deps > 0 ? `已安装 ${r.title}（含 ${deps} 个前置依赖）` : `已安装 ${r.title}`);
      if (result.optionalDependencies.length > 0) {
        toast.toast(`可选前置未装：${result.optionalDependencies.map(d => d.title).join('、')}`, 'info');
      }
    } catch (e) { toast.toast(String(e), 'error'); } finally { setInstalling(null); }
  };

  return (
    <div className="panel">
      <div className="row" style={{ gap: 8 }}>
        <input autoFocus className="input" style={{ flex: 1 }} placeholder={`搜索模组…（按 ${instance.mcVersion} · ${instance.loader} 过滤）`} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} />
        <select className="input" style={{ width: 120 }} value={index} onChange={e => setIndex(e.target.value as any)}>
          <option value="downloads">下载量</option>
          <option value="relevance">相关度</option>
          <option value="follows">关注数</option>
          <option value="updated">最近更新</option>
        </select>
        <button className="btn primary" onClick={search} disabled={searching}>{searching ? '搜索中…' : '搜索'}</button>
        <button className={`btn small ${onlyFavorites ? 'primary' : ''}`} onClick={() => setOnlyFavorites(v => !v)} title="只看收藏的资源（PCL CE 式资源收藏夹）"><Icon name="star" size={12} /> 只看收藏</button>
      </div>
      <div className="faint mt">数据源：Modrinth（中文搜索已按相关度优化，受影响较小）。{loader ? `安装的模组都按 ${loader} 过滤。` : '原版实例无法安装模组，请先创建 Fabric/Forge 实例。'}</div>
      <div className="list mt">
        {(onlyFavorites ? results.filter(r => favoriteIds.includes(r.projectId)) : results).map(r => (
          <div key={r.projectId} className="list-row">
            {r.iconUrl ? <img src={r.iconUrl} alt="" width={48} height={48} style={{ borderRadius: 10, objectFit: 'cover' }} loading="lazy" /> : <div style={{ width: 48, height: 48, borderRadius: 10, background: 'var(--panel-3)', display: 'grid', placeItems: 'center' }}><Icon name="puzzle" size={20} /></div>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row" style={{ gap: 8 }}><strong style={{ fontSize: 13.5 }}>{r.title}</strong><span className="faint">by {r.author}</span></div>
              <div className="faint" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.description}</div>
              <div className="faint" style={{ marginTop: 2 }} title={r.gameVersions.length > 0 ? `支持的游戏版本：${r.gameVersions.join(' / ')}` : undefined}>⬇ {r.downloads.toLocaleString()} · ❤ {r.follows.toLocaleString()} · {versionSupportLabel(r.gameVersions, instance.mcVersion)}</div>
            </div>
            <FavoriteButton id={r.projectId} />
            <button className="btn small primary" onClick={() => install(r)} disabled={!loader || !!installing}>{installing === r.projectId ? '安装中…' : '安装'}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ImportTab({ onImported }: { onImported?: (instanceId: string) => void }) {
  const [logs, setLogs] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<any>(null);
  const toast = useToast();

  useEffect(() => on('modpack:log', (line: string) => setLogs(prev => [...prev, line])), []);

  const start = async () => {
    setImporting(true); setResult(null); setLogs([]);
    try {
      const res = await api.modpackImportDialog();
      if (res) {
        setResult(res);
        // 导入会创建新实例：刷新下拉框并选中它，否则要切页面才能看到
        if (res.instanceId) onImported?.(res.instanceId);
        toast.toast(res.instanceId ? '整合包导入完成' : '导入失败', res.instanceId ? 'ok' : 'error');
      }
    } catch (e) { toast.toast(String(e), 'error'); } finally { setImporting(false); }
  };

  return (
    <div className="panel">
      <div className="panel-title">导入整合包</div>
      <p className="muted" style={{ marginBottom: 12 }}>
        支持 <strong>Modrinth</strong>（.mrpack / 含 modrinth.index.json 的 zip）、<strong>CurseForge</strong>（manifest.json）与 <strong>MultiMC 官方格式</strong>。
        即使压缩包嵌套了多层目录也能自动识别。CurseForge 模组因平台策略需要 API 密钥，没有密钥时会给出逐项手动下载链接，绝不静默失败。
      </p>
      <button className="btn primary" onClick={start} disabled={importing}>{importing ? '导入中…' : '选择整合包 .zip 文件'}</button>
      {logs.length > 0 && <div className="log-strip mt" style={{ height: 180 }}>{logs.map((l, i) => <div key={i} className="line">{l}</div>)}</div>}
      {result && (
        <div className="mt">
          {result.instanceId
            ? <div className="tag green">实例已创建（{result.format} 格式，{result.importedMods} 个文件/模组）</div>
            : <div className="tag red">导入失败</div>}
          {result.warnings?.length > 0 && <ul className="faint mt" style={{ paddingLeft: 18 }}>{result.warnings.map((w: string, i: number) => <li key={i}>{w}</li>)}</ul>}
          {result.manualDownloads?.length > 0 && (
            <div className="mt">
              <div className="faint">需要手动下载的模组：</div>
              {result.manualDownloads.map((d: { name: string; url: string }, i: number) => (
                <button key={i} className="btn small ghost" style={{ display: 'block', marginTop: 6 }} onClick={() => api.openExternal(d.url).catch(e => toast.toast(String(e), 'error'))}>🔗 {d.name}</button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
