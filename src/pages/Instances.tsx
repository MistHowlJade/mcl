import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Modal, Tip, Toggle, ConfirmModal, formatBytes, timeAgo } from '../components/Modal';
import type { ExportFormat, InstanceConfig, InstanceInfo, LoaderType, MemoryPreset } from '../../electron/shared/types';

const PRESET_INFO: Record<MemoryPreset, { label: string; hint: string; badge: string }> = {
  low: { label: '低配机器', hint: '1G 初始 / 2G 最大，适合原版与小型模组，老笔记本可用', badge: '2G' },
  standard: { label: '标准', hint: '2G 初始 / 4G 最大，适合大多数整合包（推荐）', badge: '4G' },
  heavy: { label: '大型整合包 / 光影', hint: '4G 初始 / 8G 最大 + G1GC 低停顿参数（Aikar 参数），光影与大型包专用', badge: '8G' },
};

export default function Instances() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<InstanceInfo | null>(null);
  const [exportTarget, setExportTarget] = useState<InstanceInfo | null>(null);
  const toast = useToast();

  const reload = () => api.instancesList().then(setInstances).catch(e => toast.toast(String(e), 'error'));
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  const diskUsage = async (id: string) => {
    const u = await api.instanceDiskUsage(id);
    toast.toast(`实例占用 ${formatBytes(u.instance)}\n共享库/资源（全实例复用）占用 ${formatBytes(u.shared)}`, 'info');
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>实例管理</h1>
          <div className="sub">每个实例 = 一个完全隔离的世界：存档、模组、配置互不影响</div>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>＋ 创建实例</button>
      </div>

      {instances.length === 0 && <div className="empty"><div className="big">📦</div>还没有实例，点右上角创建第一个</div>}

      <div className="grid cols-2">
        {instances.map(inst => (
          <InstanceCard key={inst.id} inst={inst} onReload={reload} onDiskUsage={diskUsage} onDelete={setDeleteTarget} onExport={setExportTarget} />
        ))}
      </div>

      {creating && <CreateInstanceModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void reload(); }} />}
      {exportTarget && <ExportModal inst={exportTarget} onClose={() => setExportTarget(null)} />}
      {deleteTarget && (
        <ConfirmModal
          title="删除实例"
          message={`将删除实例「${deleteTarget.name}」及其全部存档、模组、配置。\n\nMCL 会先把实例打包为 zip 存放到 backups/deleted-instances/，确认无误后再彻底删除。`}
          confirmText="备份并删除"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            api.instanceDelete(deleteTarget.id).then(r => {
              toast.toast(r.ok ? '实例已备份并删除' : '删除失败', r.ok ? 'ok' : 'error');
              setDeleteTarget(null);
              void reload();
            });
          }}
        />
      )}
    </div>
  );
}

export function InstanceCard({ inst, onReload, onDiskUsage, onDelete, onExport }: { inst: InstanceInfo; onReload: () => void; onDiskUsage: (id: string) => void; onDelete: (inst: InstanceInfo) => void; onExport: (inst: InstanceInfo) => void }) {
  const [editing, setEditing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [name, setName] = useState(inst.name);
  const [mcVersion, setMcVersion] = useState(inst.mcVersion === 'unknown' ? '' : inst.mcVersion);
  const toast = useToast();

  const duplicate = async () => {
    setDuplicating(true);
    try {
      const created = await api.instanceDuplicate(inst.id);
      toast.toast(`已复制为「${created.name}」`, 'ok');
      onReload();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setDuplicating(false); }
  };

  const save = async () => {
    const patch: Record<string, string> = {};
    const n = name.trim();
    if (n && n !== inst.name) patch.name = n;
    if (inst.mcVersion === 'unknown' && mcVersion.trim()) patch.mcVersion = mcVersion.trim();
    if (Object.keys(patch).length > 0) {
      await api.instanceUpdate(inst.id, patch);
      toast.toast('已保存');
      onReload();
    }
    setEditing(false);
  };

  return (
    <div className="panel">
      <div className="row spread" style={{ marginBottom: 10 }}>
        <div className="row">
          <div className="mc-icon" style={{ width: 46, height: 46, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'linear-gradient(140deg,#3b4a3f,#222c26)', fontSize: 22 }}>🧱</div>
          <div>
            {editing ? (
              <input className="input" style={{ maxWidth: 200, padding: '4px 8px' }} value={name} onChange={e => setName(e.target.value)} autoFocus onKeyDown={e => e.key === 'Enter' && save()} />
            ) : (
              <div style={{ fontWeight: 750 }}>{inst.name}</div>
            )}
            <div className="faint">
              {inst.mcVersion === 'unknown'
                ? <span className="tag amber">MC 版本未识别</span>
                : `${inst.mcVersion}`} · {inst.loader}{inst.loaderVersion ? ` ${inst.loaderVersion}` : ''}
            </div>
          </div>
        </div>
        <span className="tag blue">{PRESET_INFO[inst.memoryPreset ?? 'standard'].badge} 内存</span>
      </div>
      {inst.mcVersion === 'unknown' && (
        <div className="row mt" style={{ gap: 8 }}>
          <span className="faint">设置版本后才能启动</span>
          <input className="input" style={{ width: 120, padding: '4px 8px' }} placeholder="如 1.20.1" value={mcVersion} onChange={e => setMcVersion(e.target.value)} onKeyDown={e => e.key === 'Enter' && save()} />
          <button className="btn small primary" onClick={save}>保存</button>
        </div>
      )}
      <div className="row faint" style={{ gap: 14 }}>
        <span>🧩 {inst.modsCount} 模组</span>
        <span>🌍 {inst.savesCount} 存档</span>
        <span>🕐 {timeAgo(inst.lastPlayedAt)}</span>
      </div>
      <div className="row spread mt">
        <div className="row" style={{ gap: 8 }}>
          <span className="faint">禁止 Mod 自动更新</span>
          <Tip text="开启后，此实例不会提示任何模组可更新。适合整合包玩家避免随手更新导致版本错乱（大坑，官方没有这个开关时只能服主口头叮嘱）。" />
          <Toggle checked={!!inst.noModUpdate} onChange={v => api.instanceUpdate(inst.id, { noModUpdate: v }).then(onReload)} label="禁止 Mod 自动更新" />
        </div>
        <div className="row" style={{ gap: 6 }}>
          <span className="faint">内存</span>
          <select className="input" style={{ width: 110, padding: '4px 8px' }} value={inst.memoryPreset ?? 'standard'} onChange={e => api.instanceUpdate(inst.id, { memoryPreset: e.target.value }).then(onReload)}>
            {(Object.keys(PRESET_INFO) as MemoryPreset[]).map(k => <option key={k} value={k}>{PRESET_INFO[k].label}</option>)}
          </select>
        </div>
      </div>
      <div className="row mt" style={{ gap: 8, flexWrap: 'wrap' }}>
        {editing ? (
          <>
            <button className="btn small primary" onClick={save}>保存</button>
            <button className="btn small ghost" onClick={() => { setEditing(false); setName(inst.name); setMcVersion(inst.mcVersion === 'unknown' ? '' : inst.mcVersion); }}>取消</button>
          </>
        ) : (
          <button className="btn small" onClick={() => setEditing(true)}>重命名</button>
        )}
        <button className="btn small" onClick={() => api.instanceOpenGameDir(inst.id)}>打开游戏目录</button>
        <button className="btn small" onClick={() => api.instanceOpenDir(inst.id)}>实例文件夹</button>
        <button className="btn small" onClick={() => onDiskUsage(inst.id)}>磁盘占用</button>
        <button className="btn small" onClick={() => setAdvanced(true)}>高级设置</button>
        <button className="btn small" onClick={duplicate} disabled={duplicating} title="完整复制模组、存档与配置，适合开新档或测试模组">
          {duplicating ? '复制中…' : '复制实例'}
        </button>
        <button className="btn small" onClick={() => onExport(inst)}>导出…</button>
        <button className="btn small danger" onClick={() => onDelete(inst)}>删除…</button>
      </div>
      {advanced && <AdvancedSettingsModal inst={inst} onClose={() => setAdvanced(false)} onSaved={() => { setAdvanced(false); onReload(); }} />}
    </div>
  );
}

function AdvancedSettingsModal({ inst, onClose, onSaved }: { inst: InstanceInfo; onClose: () => void; onSaved: () => void }) {
  const [javaPath, setJavaPath] = useState(inst.javaPath ?? '');
  const [jvm, setJvm] = useState(inst.jvmArgsExtra ?? '');
  const [width, setWidth] = useState(inst.resolution?.width ? String(inst.resolution.width) : '');
  const [height, setHeight] = useState(inst.resolution?.height ? String(inst.resolution.height) : '');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  const browseJava = async () => {
    try {
      const p = await api.pickFile([{ name: '所有文件', extensions: ['*'] }]);
      if (p) setJavaPath(p);
    } catch (e) { toast.toast(String(e), 'error'); }
  };

  const save = async () => {
    const w = parseInt(width, 10);
    const h = parseInt(height, 10);
    if ((width || height) && (!Number.isFinite(w) || !Number.isFinite(h) || w < 640 || h < 360 || w > 7680 || h > 4320)) {
      toast.toast('分辨率需要同时填写，且范围在 640×360 到 7680×4320 之间', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.instanceUpdate(inst.id, {
        javaPath: javaPath.trim() || null,
        jvmArgsExtra: jvm,
        resolution: width && height ? { width: w, height: h } : null,
      });
      toast.toast('实例高级设置已保存');
      onSaved();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={`高级设置 · ${inst.name}`} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
    </>}>
      <div className="setting-row" style={{ paddingTop: 4 }}>
        <div className="label">Java 路径<Tip text="留空 = 按该实例的 Minecraft 版本自动匹配，缺失时自动下载 Temurin。只有想强制使用某个 Java 时才填写。填错会导致启动失败。" /></div>
        <div className="control">
          <input className="input" style={{ flex: 1 }} placeholder="留空 = 自动管理（推荐）" value={javaPath} onChange={e => setJavaPath(e.target.value)} />
          <button className="btn small" onClick={browseJava}>浏览…</button>
          {javaPath && <button className="btn small ghost" onClick={() => setJavaPath('')}>清空</button>}
        </div>
      </div>
      <div className="setting-row">
        <div className="label">实例 JVM 参数<Tip text="只对这个实例生效，每行一条或空格分隔。会加在内存预设与全局参数之间。例如 -XX:+UseZGC。不确定就不要填。" /></div>
        <div className="control"><textarea className="input" style={{ width: '100%', maxWidth: 480, minHeight: 80 }} placeholder="-XX:+UseG1GC" value={jvm} onChange={e => setJvm(e.target.value)} /></div>
      </div>
      <div className="setting-row">
        <div className="label">游戏窗口分辨率<Tip text="留空 = 使用「设置 → 常规」里的默认分辨率。填写后启动参数会带上 --width/--height。两个框要么都填，要么都留空。" /></div>
        <div className="control">
          <input className="input" style={{ width: 90 }} type="number" placeholder="宽" value={width} onChange={e => setWidth(e.target.value)} />
          <span className="faint">×</span>
          <input className="input" style={{ width: 90 }} type="number" placeholder="高" value={height} onChange={e => setHeight(e.target.value)} />
        </div>
      </div>
      <p className="faint mt">内存仍由「内存预设」管理；想精细控制请用 JVM 参数（不推荐新手改，容易 OutOfMemory 或频繁 GC）。</p>
    </Modal>
  );
}

const EXPORT_FORMATS: Array<{ id: ExportFormat; label: string; hint: string; ext: string }> = [
  { id: 'mmc', label: 'MultiMC / Prism 实例', hint: '生成 mmc-pack.json + instance.cfg + .minecraft/，可直接拖进 Prism Launcher 导入。适合迁移到别的启动器。', ext: '.zip' },
  { id: 'mrpack', label: 'Modrinth 整合包（.mrpack）', hint: '生成 modrinth.index.json + overrides/，可上传到 Modrinth 或分享给朋友用其它启动器安装。', ext: '.mrpack' },
  { id: 'zip', label: 'MCL 完整实例快照', hint: '把整个实例目录（含配置、模组、存档）打包成 ZIP，适合备份或换电脑手动恢复。体积最大。', ext: '.zip' },
];

function ExportModal({ inst, onClose }: { inst: InstanceInfo; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('mmc');
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{ filePath: string; sizeBytes: number; files: number; warnings?: string[] } | null>(null);
  const toast = useToast();

  const submit = async () => {
    setExporting(true);
    setResult(null);
    try {
      const r = await api.instanceExport(inst.id, format);
      if (!r) return;
      setResult(r);
      toast.toast('实例已导出', 'ok');
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setExporting(false); }
  };

  return (
    <Modal title={`导出实例 · ${inst.name}`} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>{result ? '关闭' : '取消'}</button>
      {!result && <button className="btn primary" onClick={submit} disabled={exporting}>{exporting ? '导出中…' : '选择保存位置并导出'}</button>}
    </>}>
      <p className="muted">导出只读取实例目录，不会修改原实例。共享库与版本文件不会打包，目标启动器会按需下载。</p>
      <div className="mt" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {EXPORT_FORMATS.map(f => (
          <label key={f.id} className="row" style={{ gap: 10, padding: '10px 12px', border: `1px solid ${format === f.id ? 'var(--accent-strong)' : 'var(--border-soft)'}`, borderRadius: 9, cursor: 'pointer', background: format === f.id ? 'var(--accent-soft)' : 'transparent' }}>
            <input type="radio" name="export-format" checked={format === f.id} onChange={() => setFormat(f.id)} />
            <span style={{ flex: 1 }}>
              <div style={{ fontWeight: 650 }}>{f.label}<span className="tag" style={{ marginLeft: 8 }}>{f.ext}</span></div>
              <div className="faint">{f.hint}</div>
            </span>
          </label>
        ))}
      </div>
      {result && (
        <div className="mt" style={{ padding: '10px 14px', borderRadius: 9, background: 'var(--accent-soft)', border: '1px solid rgba(93,211,158,.35)' }}>
          <div style={{ fontWeight: 700 }}>✓ 导出完成</div>
          <div className="faint mono" style={{ marginTop: 6, wordBreak: 'break-all' }}>{result.filePath}</div>
          <div className="faint">大小 {formatBytes(result.sizeBytes)} · {result.files} 个文件</div>
          {result.warnings && result.warnings.length > 0 && (
            <ul className="faint" style={{ paddingLeft: 18, marginTop: 6 }}>{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
          )}
        </div>
      )}
    </Modal>
  );
}

function CreateInstanceModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [versions, setVersions] = useState<Array<{ id: string; type: string; releaseTime: string }>>([]);
  const [search, setSearch] = useState('');
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [mcVersion, setMcVersion] = useState('');
  const [loader, setLoader] = useState<LoaderType>('vanilla');
  const [loaderVersion, setLoaderVersion] = useState('');
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<MemoryPreset>('standard');
  const [recommendedJava, setRecommendedJava] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.versionsList().then(list => {
      setVersions(list);
      const firstRelease = list.find(v => v.type === 'release');
      if (firstRelease) setMcVersion(firstRelease.id);
    }).catch(e => toast.toast(`版本清单加载失败：${e}`, 'error'));
    /* eslint-disable-next-line */
  }, []);

  useEffect(() => {
    if (mcVersion) api.javaRecommended(mcVersion).then(r => setRecommendedJava(r.major)).catch(() => setRecommendedJava(null));
  }, [mcVersion]);

  const filtered = useMemo(() => {
    return versions.filter(v =>
      (showSnapshots || v.type === 'release' || v.type === 'old_beta' || v.type === 'old_alpha') &&
      v.id.toLowerCase().includes(search.toLowerCase()),
    ).slice(0, 120);
  }, [versions, search, showSnapshots]);

  const submit = async () => {
    if (!mcVersion) { toast.toast('请选择 Minecraft 版本', 'error'); return; }
    setCreating(true);
    try {
      await api.instanceCreate({
        name: name.trim() || `${mcVersion}${loader !== 'vanilla' ? ' · ' + loader : ''}`,
        mcVersion,
        loader,
        loaderVersion: loader === 'vanilla' ? null : (loaderVersion.trim() || null),
        memoryPreset: preset,
      });
      toast.toast('实例已创建');
      onCreated();
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal title="创建实例" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={submit} disabled={creating || !mcVersion}>{creating ? '创建中…' : '创建'}</button>
    </>}>
      <div className="setting-row" style={{ paddingTop: 4 }}>
        <div className="label">实例名称<Tip text="显示在启动台上的名字。留空会自动生成，比如「1.20.1 · fabric」。" /></div>
        <div className="control"><input className="input" value={name} placeholder="例如：生存 · 1.20.1 光影包" onChange={e => setName(e.target.value)} /></div>
      </div>

      <div className="setting-row">
        <div className="label">Minecraft 版本<Tip text="正式版（release）默认显示；勾选左侧「显示快照」可看到 snapshots。版本清单来自 Mojang 官方。" /></div>
        <div className="control" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div className="row">
            <input className="input" value={search} placeholder="搜索版本号，如 1.20 / 1.7.10…" onChange={e => setSearch(e.target.value)} />
            <Toggle checked={showSnapshots} onChange={setShowSnapshots} label="显示快照版本" />
          </div>
          <select className="input" size={7} value={mcVersion} onChange={e => setMcVersion(e.target.value)}>
            {filtered.map(v => <option key={v.id} value={v.id}>{v.id}{v.type !== 'release' ? `（${v.type}）` : ''}</option>)}
          </select>
          <div className="faint">将下载 {filtered.length > 0 ? `${versions.length} 个版本中的清单` : ''} · {mcVersion || '未选择'} · 需要 Java {recommendedJava ?? '…'}（MCL 会自动下载）</div>
        </div>
      </div>

      <div className="setting-row">
        <div className="label">加载器<Tip text="模组加载器决定能装什么模组。Fabric 轻量生态好，Forge 老牌存量大，NeoForge 是 Forge 的继任者，Quilt 兼容 Fabric。不玩模组就选原版。" /></div>
        <div className="control">
          <select className="input" value={loader} onChange={e => setLoader(e.target.value as LoaderType)} style={{ maxWidth: 220 }}>
            <option value="vanilla">原版 Vanilla</option>
            <option value="fabric">Fabric</option>
            <option value="quilt">Quilt</option>
            <option value="forge">Forge</option>
            <option value="neoforge">NeoForge</option>
          </select>
        </div>
      </div>
      {loader !== 'vanilla' && (
        <div className="setting-row">
          <div className="label">加载器版本<Tip text="留空 = 自动使用该 Minecraft 版本下的最新稳定版；要装整合包时填整合包要求的版本（例如 fabric-loader 0.15.7）。" /></div>
          <div className="control"><input className="input" value={loaderVersion} placeholder="留空 = 最新稳定版" onChange={e => setLoaderVersion(e.target.value)} /></div>
        </div>
      )}

      <div className="setting-row">
        <div className="label">内存预设<Tip text="少了会 OutOfMemoryError 崩溃，多了反而触发频繁 GC 卡顿。预设是按机型和常见场景设计的，不确定就选「标准」。" /></div>
        <div className="control" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          {(Object.keys(PRESET_INFO) as MemoryPreset[]).map(key => (
            <label key={key} className="row" style={{ gap: 10, padding: '8px 10px', border: `1px solid ${preset === key ? 'var(--accent-strong)' : 'var(--border-soft)'}`, borderRadius: 8, cursor: 'pointer', background: preset === key ? 'var(--accent-soft)' : 'transparent' }}>
              <input type="radio" name="preset" checked={preset === key} onChange={() => setPreset(key)} />
              <span style={{ flex: 1 }}>
                <div style={{ fontWeight: 650 }}>{PRESET_INFO[key].label}<span className="tag green" style={{ marginLeft: 8 }}>{PRESET_INFO[key].badge}</span></div>
                <div className="faint">{PRESET_INFO[key].hint}</div>
              </span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
