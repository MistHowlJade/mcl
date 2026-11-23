import React, { useEffect, useMemo, useState } from 'react';
import { api, on } from '../lib/api';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { formatBytes, timeAgo } from '../components/Modal';
import type { DownloadTaskInfo, TaskKind } from '../../electron/shared/types';

const KIND_LABEL: Record<TaskKind, string> = {
  launch: '游戏文件', mod: '模组', resourcepack: '资源包', shader: '光影', world: '世界',
  modpack: '整合包', java: 'Java', update: '启动器更新', server: '服务端', other: '下载',
};
const KIND_ICON: Record<TaskKind, string> = {
  launch: 'play', mod: 'puzzle', resourcepack: 'palette', shader: 'shader', world: 'globe',
  modpack: 'box', java: 'cog', update: 'download', server: 'server', other: 'download',
};
type Filter = 'all' | 'running' | 'done' | 'failed';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' }, { id: 'running', label: '进行中' },
  { id: 'done', label: '已完成' }, { id: 'failed', label: '失败/取消' },
];

export default function Tasks() {
  const [tasks, setTasks] = useState<DownloadTaskInfo[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(true);
  const toast = useToast();

  const load = () => api.tasksList().then(setTasks).catch(e => toast.toast(String(e), 'error')).finally(() => setBusy(false));
  useEffect(() => {
    void load();
    const off = on('tasks:changed', (list: DownloadTaskInfo[]) => { setTasks(Array.isArray(list) ? list : []); setBusy(false); });
    return off;
    /* eslint-disable-next-line */
  }, []);

  const list = useMemo(() => {
    if (filter === 'all') return tasks;
    if (filter === 'failed') return tasks.filter(t => t.status === 'failed' || t.status === 'canceled');
    return tasks.filter(t => t.status === filter);
  }, [tasks, filter]);
  const runningCount = tasks.filter(t => t.status === 'running').length;

  const clearFinished = async () => {
    try { await api.tasksClearFinished(); toast.toast('已清除结束的记录', 'ok'); void load(); }
    catch (e) { toast.toast(String(e), 'error'); }
  };

  const open = (task: DownloadTaskInfo) => {
    if (task.action?.openDir) {
      api.openPath(task.action.openDir).catch(e => toast.toast(String(e), 'error'));
    } else if (task.action?.revealFile) {
      api.appRevealFile(task.action.revealFile).then(ok => {
        if (!ok) toast.toast('文件已经不在原位置了', 'info');
      }).catch(e => toast.toast(String(e), 'error'));
    } else {
      toast.toast('这个任务没有可打开的目录', 'info');
    }
  };

  const retry = async (task: DownloadTaskInfo) => {
    const r = task.action?.retry;
    if (!r) { toast.toast('这类任务请在对应页面重新操作', 'info'); return; }
    setBusy(true);
    try {
      if (r.type === 'update') await api.appUpdateDownload();
      else if (r.type === 'java') await api.javaInstall(r.major);
      else if (r.type === 'modpack') await api.modpackImportFile(r.filePath);
      else if (r.type === 'launch') await api.launchStart(r.instanceId);
      toast.toast('已重新开始，进度会更新到本页', 'ok');
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(false); void load(); }
  };

  const cancel = async (task: DownloadTaskInfo) => {
    try { await api.tasksCancel(task.id); toast.toast('已请求取消，任务会标记为已取消', 'info'); void load(); }
    catch (e) { toast.toast(String(e), 'error'); }
  };

  const remove = async (task: DownloadTaskInfo) => {
    try { await api.tasksRemove(task.id); setTasks(prev => prev.filter(t => t.id !== task.id)); }
    catch (e) { toast.toast(String(e), 'error'); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>下载任务</h1>
          <div className="sub">游戏文件、模组、Java 与更新都汇集在这里；记录只存本机，不含任何下载内容</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {runningCount > 0 && <span className="tag blue">{runningCount} 个进行中</span>}
          <button className="btn small" onClick={() => void load()}>刷新</button>
          <button className="btn small ghost" onClick={() => void clearFinished()}>清除已完成</button>
        </div>
      </div>

      <div className="tab-bar">
        {FILTERS.map(f => (
          <button key={f.id} className={`tab ${filter === f.id ? 'active' : ''}`} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="empty"><div className="big"><Icon name="download" size={30} /></div>
          {busy ? '正在读取任务…' : filter === 'all' ? '还没有下载记录。启动游戏、装模组或更新启动器后会出现在这里' : '这个分类下没有任务'}
        </div>
      ) : (
        <div className="task-list">
          {list.map(task => {
            const pct = task.bytesTotal > 0 ? Math.min(100, Math.round((task.bytesDone / task.bytesTotal) * 100)) : null;
            const statusClass = task.status === 'done' ? 'green' : task.status === 'failed' ? 'red' : task.status === 'canceled' ? '' : 'blue';
            const statusText = task.status === 'running' ? (pct === null ? '进行中' : `${pct}%`)
              : task.status === 'done' ? '已完成' : task.status === 'failed' ? '失败' : '已取消';
            return (
              <div key={task.id} className="task-row">
                <div className="task-icon"><Icon name={KIND_ICON[task.kind] ?? 'download'} size={17} /></div>
                <div className="task-main">
                  <div className="task-head">
                    <span className="task-name" title={task.name}>{task.name}</span>
                    <span className="tag">{KIND_LABEL[task.kind] ?? '下载'}</span>
                    <span className={`tag ${statusClass}`}>{statusText}</span>
                  </div>
                  {task.bytesTotal > 0 && (
                    <div className="progress"><div style={{ width: `${Math.min(100, (task.bytesDone / task.bytesTotal) * 100)}%` }} /></div>
                  )}
                  <div className="task-meta">
                    <span>{formatBytes(task.bytesDone)}{task.bytesTotal > 0 ? ` / ${formatBytes(task.bytesTotal)}` : ''}</span>
                    {task.status === 'running' && task.speed > 0 && <span>{formatBytes(task.speed)}/秒</span>}
                    <span>{timeAgo(task.startedAt)}开始</span>
                    {task.finishedAt && <span>{timeAgo(task.finishedAt)}结束</span>}
                  </div>
                  {task.error && <div className="task-error">{task.error}</div>}
                </div>
                <div className="task-actions">
                  {task.status === 'running' && task.cancelable && (
                    <button className="btn small" onClick={() => void cancel(task)} title="取消这次下载；下次可以从「重试」重新开始"><Icon name="pause" size={11} /> 取消</button>
                  )}
                  {(task.action?.openDir || task.action?.revealFile) && (
                    <button className="btn small" onClick={() => open(task)} title="打开所在文件夹">打开目录</button>
                  )}
                  {task.action?.retry && (
                    <button className="btn small" onClick={() => void retry(task)} disabled={busy} title="用同样的参数重新开始">重试</button>
                  )}
                  <button className="btn small ghost" onClick={() => void remove(task)} title="仅移除这条记录">移除</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
