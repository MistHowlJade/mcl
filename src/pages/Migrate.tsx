import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { formatBytes } from '../components/Modal';
import type { MigrationCandidate, MigrationPreview, MigrationResult } from '../../electron/shared/types';

export default function Migrate() {
  const [candidates, setCandidates] = useState<MigrationCandidate[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<MigrationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.migrateDetect().then(setCandidates).catch(e => toast.toast(String(e), 'error'));
    /* eslint-disable-next-line */
  }, []);

  const loadPreview = async (root: string) => {
    setBusy(true);
    setResult(null);
    setSelectedPath(root);
    try {
      const p = await api.migratePreview(root);
      setPreview(p);
      setSelected(p.instances.map(i => i.name));
      if (p.instances.length === 0) toast.toast('这个目录里没有识别出可迁移的实例', 'info');
    } catch (e) { toast.toast(String(e), 'error'); setPreview(null); } finally { setBusy(false); }
  };

  const pickFolder = async () => {
    const folder = await api.pickFolder();
    if (folder) await loadPreview(folder);
  };

  const doImport = async () => {
    if (!selectedPath || selected.length === 0) return;
    setBusy(true);
    try {
      const r = await api.migrateImport(selectedPath, selected);
      setResult(r);
      toast.toast(`迁移完成：${r.imported.length} 个实例已导入${r.skipped.length ? `，${r.skipped.length} 个跳过` : ''}`, r.skipped.length ? 'info' : 'ok');
    } catch (e) { toast.toast(String(e), 'error'); } finally { setBusy(false); }
  };

  const totalBytes = preview?.instances.reduce((a, i) => a + i.totalBytes, 0) ?? 0;
  const totalSaves = preview?.instances.reduce((a, i) => a + i.saves.length, 0) ?? 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>迁移中心</h1>
          <div className="sub">从 HMCL / PCL2 / Prism / MultiMC / .minecraft 一键搬家——存档、模组、配置全带走</div>
        </div>
        <button className="btn" onClick={pickFolder}>📁 手动选择目录…</button>
      </div>

      <div className="panel">
        <div className="panel-title">自动检测到的启动器数据</div>
        <div className="grid cols-2">
          {candidates.map(c => (
            <button key={c.launcher + c.path} className={`panel`} style={{ textAlign: 'left', cursor: c.exists ? 'pointer' : 'not-allowed', opacity: c.exists ? 1 : 0.45, border: `1px solid ${selectedPath === c.path ? 'var(--accent-strong)' : 'var(--border-soft)'}` }} onClick={() => c.exists && loadPreview(c.path)} disabled={!c.exists}>
              <div className="row spread"><strong>{c.launcher}</strong>{c.exists ? <span className="tag green">已找到</span> : <span className="tag">未安装</span>}</div>
              <div className="faint" style={{ marginTop: 4 }}>{c.hint}</div>
              <div className="mono" style={{ marginTop: 6, color: 'var(--text-faint)', fontSize: 11, wordBreak: 'break-all' }}>{c.path}</div>
            </button>
          ))}
        </div>
      </div>

      {busy && <div className="empty"><div className="big">🔄</div>扫描 / 导入中…</div>}

      {preview && !busy && (
        <div className="panel">
          <div className="panel-title">迁移预览（{preview.instances.length} 个实例 · 共 {formatBytes(totalBytes)} · {totalSaves} 个存档世界）</div>
          {preview.instances.length === 0 && <div className="faint">没有找到可迁移的实例。如果是自定义目录，确认里面有 versions/ 或 saves/ 文件夹。</div>}
          {preview.instances.map(inst => (
            <label key={inst.name} className="list-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.includes(inst.name)} onChange={e => setSelected(prev => e.target.checked ? [...prev, inst.name] : prev.filter(n => n !== inst.name))} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}><strong>{inst.name}</strong>{inst.mcVersion && <span className="tag">{inst.mcVersion}</span>}{inst.loader !== 'vanilla' && <span className="tag blue">{inst.loader}</span>}</div>
                <div className="faint">🌍 {inst.saves.length} 存档{inst.saves.length > 0 ? `（${inst.saves.slice(0, 2).join('、')}${inst.saves.length > 2 ? '…' : ''}）` : ''} · 🧩 {inst.modsCount} 模组 · ⚙️ {inst.configFiles} 配置 · {formatBytes(inst.totalBytes)}</div>
              </div>
            </label>
          ))}
          {preview.instances.length > 0 && (
            <div className="row spread mt">
              <div className="faint">库（libraries）和资源（assets）不会复制——MCL 共享目录按需重新下载，节省数 GB 磁盘</div>
              <button className="btn primary" onClick={doImport} disabled={selected.length === 0}>导入选中的 {selected.length} 个实例</button>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="panel">
          <div className="panel-title">迁移结果</div>
          {result.imported.length > 0 && <div className="tag green" style={{ marginRight: 6 }}>成功 {result.imported.length} 个：{result.imported.join('、')}</div>}
          {result.skipped.length > 0 && (
            <ul className="faint mt" style={{ paddingLeft: 18 }}>
              {result.skipped.map(s => <li key={s.name}>{s.name}：{s.reason}</li>)}
            </ul>
          )}
          <p className="faint mt">原启动器的数据不会被修改或删除；实例创建后可在「实例」页调整内存/Java 设置。</p>
        </div>
      )}
    </div>
  );
}
