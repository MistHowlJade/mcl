import React, { useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/ui';
import { useInstanceSelection } from '../lib/hooks';
import type { BatchResult, ExportFormat } from '../../electron/shared/types';

type Operation = 'backup' | 'updates' | 'export';

export default function Batch() {
  const { instances } = useInstanceSelection();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<ExportFormat>('mrpack');
  const [results, setResults] = useState<BatchResult[] | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const toast = useToast();

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const run = async (operation: Operation) => {
    if (selected.size === 0) { toast.toast('先勾选要操作的实例', 'info'); return; }
    const ids = [...selected];
    let destDir = '';
    if (operation === 'export') {
      const picked = await api.pickFolder();
      if (!picked) return;
      destDir = picked;
    }
    setBusy(operation);
    setResults(null);
    try {
      const result = operation === 'backup'
        ? await api.batchBackup(ids)
        : operation === 'updates'
          ? await api.batchCheckUpdates(ids)
          : await api.batchExport(ids, format, destDir);
      setResults(result);
      const ok = result.filter(item => item.ok).length;
      toast.toast(`批量操作完成：${ok} / ${result.length} 个成功`, ok === result.length ? 'ok' : 'info');
    } catch (e) { toast.toast(String(e), 'error'); }
    finally { setBusy(null); }
  };

  if (instances.length === 0) return <EmptyState icon="layers" title="还没有实例" description="先创建实例，才能进行批量运维。" />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>批量运维</h1>
          <div className="sub">一次勾选多个实例，批量备份存档、检查模组更新或导出；每项独立报告结果，单项失败不影响其他实例。</div>
        </div>
        <div className="row">
          <span className="tag">{selected.size} / {instances.length} 已选</span>
          <button className="btn small ghost" onClick={() => setSelected(new Set())}>清空</button>
          <button className="btn small ghost" onClick={() => setSelected(new Set(instances.map(i => i.id)))}>全选</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">选择实例</div>
        <div className="list">
          {instances.map(instance => (
            <label key={instance.id} className="list-row" style={{ cursor: 'pointer' }}>
              <input type="checkbox" checked={selected.has(instance.id)} onChange={() => toggle(instance.id)} />
              <div className="list-icon"><Icon name="box" size={17} /></div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 13 }}>{instance.name}</strong>
                <div className="faint">{instance.mcVersion} · {instance.loader} · {instance.modsCount} 个模组 · {instance.savesCount} 个存档</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="btn primary" disabled={!!busy} onClick={() => run('backup')}>{busy === 'backup' ? '备份中…' : '批量备份存档'}</button>
          <button className="btn" disabled={!!busy} onClick={() => run('updates')}>{busy === 'updates' ? '检查中…' : '批量检查模组更新'}</button>
          <select className="input" style={{ width: 'auto' }} value={format} onChange={e => setFormat(e.target.value as ExportFormat)}>
            <option value="mrpack">Modrinth .mrpack</option>
            <option value="mmc">MultiMC / Prism</option>
            <option value="zip">完整 ZIP</option>
          </select>
          <button className="btn" disabled={!!busy} onClick={() => run('export')}>{busy === 'export' ? '导出中…' : '批量导出到目录…'}</button>
        </div>
      </div>

      {results && (
        <div className="panel" style={{ marginTop: 12 }}>
          <div className="panel-title">执行结果</div>
          <div className="list">
            {results.map(item => (
              <div key={item.id} className="list-row">
                <div className="list-icon"><Icon name={item.ok ? 'check' : 'warn'} size={17} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ fontSize: 13 }}>{item.name}</strong>
                  <div className="faint" style={{ wordBreak: 'break-all' }}>{item.message}</div>
                </div>
                <span className={`tag ${item.ok ? 'green' : 'red'}`}>{item.ok ? '成功' : '失败'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
