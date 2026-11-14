import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmModal, formatBytes, timeAgo } from '../components/Modal';
import type { BackupInfo, InstanceInfo } from '../../electron/shared/types';

export default function Backups() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [instanceId, setInstanceId] = useState<string | null>(() => localStorage.getItem('mcl:selectedInstance'));
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo | null>(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.instancesList().then(list => {
      setInstances(list);
      if (!instanceId && list.length) setInstanceId(list[0].id);
    });
    /* eslint-disable-next-line */
  }, []);

  const reload = () => instanceId && api.backupList(instanceId).then(setBackups).catch(e => toast.toast(String(e), 'error'));
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [instanceId]);

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

  if (instances.length === 0) return <div className="empty"><div className="big">💾</div>还没有实例。先创建一个，存档备份才有意义。</div>;

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
        <div className="empty"><div className="big">🗄️</div>还没有备份。建议先手动备份一次，崩溃或更新翻车都能回去。</div>
      ) : (
        <div className="panel">
          <div className="list">
            {backups.map(b => (
              <div key={b.id} className="list-row">
                <div style={{ fontSize: 20 }}>{b.kind === 'auto' ? '⏰' : b.kind === 'pre-restore' ? '🛟' : b.kind === 'world' ? '🌍' : '💾'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>{b.name}</strong>
                    <span className="tag">{b.kind === 'auto' ? '自动' : b.kind === 'pre-restore' ? '恢复前' : b.kind === 'world' ? '世界' : '手动'}</span>
                  </div>
                  <div className="faint">{timeAgo(b.createdAt)} · {formatBytes(b.sizeBytes)} · {b.worldNames.length > 0 ? `世界：${b.worldNames.slice(0, 3).join('、')}${b.worldNames.length > 3 ? '…' : ''}` : '未知世界'}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
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
            : `将用「${restoreTarget.name}」覆盖当前存档。\n\nMCL 会先把当前存档再自动备份一次（恢复前备份），所以这一步不会让你丢东西。`}
          confirmText="恢复"
          onCancel={() => setRestoreTarget(null)}
          onConfirm={() => {
            api.backupRestore(restoreTarget.id, instanceId!).then(r => {
              toast.toast(`恢复完成：${r.restoredFiles} 个文件`, 'ok');
              setRestoreTarget(null);
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
          onConfirm={() => { api.backupDelete(deleteTarget.id).then(() => { toast.toast('已删除'); setDeleteTarget(null); void reload(); }).catch(e => toast.toast(String(e), 'error')); }}
        />
      )}
    </div>
  );
}
