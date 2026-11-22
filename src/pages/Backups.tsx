import React, { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmModal, formatBytes, timeAgo } from '../components/Modal';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/ui';
import { useAsyncList, useInstanceSelection } from '../lib/hooks';
import type { BackupInfo } from '../../electron/shared/types';

export default function Backups() {
  const { instances, instanceId, setInstanceId } = useInstanceSelection();
  const { items: backups, reload } = useAsyncList<BackupInfo>(
    () => (instanceId ? api.backupList(instanceId) : Promise.resolve([])),
    [instanceId],
  );
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const totalBytes = useMemo(() => backups.reduce((a, b) => a + b.sizeBytes, 0), [backups]);
  const instance = instances.find(i => i.id === instanceId) ?? null;

  const create = async () => {
    if (!instanceId) return;
    setCreating(true);
    try {
      const info = await api.backupCreate(instanceId, '手动备份');
      toast.toast(info ? `已备份 ${info.worldNames.length} 个世界（${formatBytes(info.sizeBytes)}）` : '该实例还没有存档，暂无可备份内容', info ? 'ok' : 'info');
      void reload();
    } catch (e) { toast.toast(String(e), 'error'); } finally { setCreating(false); }
  };

  if (instances.length === 0) return <div className="empty"><div className="big"><Icon name="save" size={30} /></div>还没有实例。先创建一个，存档备份才有意义。</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>存档备份</h1>
          <div className="sub">启动前自动备份 · 一键恢复 · 恢复前自动再备份一次（后悔药）</div>
        </div>
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={instanceId ?? ''} onChange={e => setInstanceId(e.target.value)}>
            {instances.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button className="btn primary" onClick={create} disabled={creating}>{creating ? '备份中…' : '＋ 立即备份'}</button>
          <button className="btn" onClick={() => {
            if (!backups[0]) { toast.toast('还没有备份文件可定位', 'info'); return; }
            api.appRevealFile(backups[0].filePath).catch(e => toast.toast(String(e), 'error'));
          }}>打开备份目录</button>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="row spread">
          <div className="row" style={{ gap: 24 }}>
            <div><div className="faint">备份数量</div><div style={{ fontSize: 20, fontWeight: 800 }}>{backups.length}</div></div>
            <div><div className="faint">占用空间</div><div style={{ fontSize: 20, fontWeight: 800 }}>{formatBytes(totalBytes)}</div></div>
            <div><div className="faint">当前实例存档</div><div style={{ fontSize: 20, fontWeight: 800 }}>{instance?.savesCount ?? 0}</div></div>
          </div>
          <div className="faint" style={{ maxWidth: 340, textAlign: 'right' }}>自动备份默认保留最近 10 份（启动前自动备份会清理更旧的），可在设置中调整</div>
        </div>
      </div>

      {backups.length === 0 ? (
        <EmptyState icon="save" title="还没有备份" description="建议先手动备份一次，崩溃或更新翻车都能回去。" />
      ) : (
        <div className="panel">
          <div className="list">
            {backups.map(b => (
              <div key={b.id} className="list-row">
                <div className="list-icon"><Icon name={b.kind === 'auto' ? 'clock' : b.kind === 'pre-restore' ? 'shield' : b.kind === 'world' ? 'globe' : 'save'} size={18} /></div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>{b.name}</strong>
                    <span className="tag">{b.kind === 'auto' ? '自动' : b.kind === 'pre-restore' ? '恢复前' : b.kind === 'world' ? '世界' : '手动'}</span>
                  </div>
                  <div className="faint">{timeAgo(b.createdAt)} · {formatBytes(b.sizeBytes)} · {b.worldNames.length > 0 ? `世界：${b.worldNames.slice(0, 3).join('、')}${b.worldNames.length > 3 ? '…' : ''}` : '未知世界'}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn small ghost" title="在文件夹中定位" onClick={() => api.appRevealFile(b.filePath).catch(e => toast.toast(String(e), 'error'))}>定位</button>
                  <button className="btn small primary" onClick={() => setRestoreTarget(b)}>恢复…</button>
                  <button className="btn small danger" onClick={() => setDeleteTarget(b)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {restoreTarget && (
        <ConfirmModal
          title="恢复备份"
          message={restoreTarget.kind === 'world'
            ? `将把「${restoreTarget.name}」还原到 saves/${restoreTarget.worldNames[0] ?? '对应世界'}。\n\n如果当前已有同名世界，会被覆盖；MCL 会先把当前存档整体再备份一次。`
            : `将用「${restoreTarget.name}」覆盖当前存档。\n\n将被替换的世界：${restoreTarget.worldNames.length > 0
              ? restoreTarget.worldNames.slice(0, 5).join('、') + (restoreTarget.worldNames.length > 5 ? '…' : '')
              : '（备份未记录世界名，将按备份内的世界目录名恢复）'}。\n\n这些世界会整体替换同名现有世界（避免新旧区块混杂）；备份之后新建的世界会保留。MCL 会先把当前存档再自动备份一次（恢复前备份）。`}
          confirmText="恢复"
          onCancel={() => setRestoreTarget(null)}
          onConfirm={() => {
            // 先关确认框，避免连点两次恢复：第二次会多打一份恢复前备份并重复解压
            const target = restoreTarget;
            setRestoreTarget(null);
            // 用备份自身的 instanceId，避免切换实例后把旧列表里的备份恢复到新实例
            api.backupRestore(target.id, target.instanceId).then(r => {
              toast.toast(`恢复完成：${r.restoredFiles} 个文件`, 'ok');
              void reload();
            }).catch(e => toast.toast(String(e), 'error'));
          }}
        />
      )}
      {deleteTarget && (
        <ConfirmModal
          title="删除备份"
          message={`确定删除备份「${deleteTarget.name}」？此操作不可撤销。`}
          confirmText="删除"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            const target = deleteTarget;
            setDeleteTarget(null);
            api.backupDelete(target.id, target.instanceId).then(() => { toast.toast('已删除'); void reload(); }).catch(e => toast.toast(String(e), 'error'));
          }}
        />
      )}
    </div>
  );
}
