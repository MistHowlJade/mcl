import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { formatBytes, timeAgo } from '../components/Modal';
import type { InstanceInfo } from '../../electron/shared/types';

interface LogEntry { name: string; sizeBytes: number; mtime: number; kind: string }

export default function Logs() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [instanceId, setInstanceId] = useState<string | null>(() => localStorage.getItem('mcl:selectedInstance'));
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [query, setQuery] = useState('');
  const toast = useToast();

  useEffect(() => {
    api.instancesList().then(list => {
      setInstances(list);
      if (!instanceId && list.length) setInstanceId(list[0].id);
    });
    /* eslint-disable-next-line */
  }, []);

  useEffect(() => {
    api.logsList(instanceId ?? undefined).then(list => {
      setLogs(list);
      if (list.length && !selected) setSelected(list[0].name);
    }).catch(() => setLogs([]));
    /* eslint-disable-next-line */
  }, [instanceId]);

  useEffect(() => {
    if (!selected) { setContent(''); return; }
    api.logsRead(selected, instanceId ?? undefined).then(setContent).catch(e => { setContent(''); toast.toast(String(e), 'error'); });
    /* eslint-disable-next-line */
  }, [selected, instanceId]);

  const filtered = useMemo(() => {
    if (!query.trim()) return content.split(/\r?\n/);
    const q = query.toLowerCase();
    return content.split(/\r?\n/).filter(l => l.toLowerCase().includes(q));
  }, [content, query]);

  const exportDiag = async () => {
    try {
      const file = await api.diagnosticExport(instanceId ?? undefined);
      if (file) toast.toast(`诊断包已导出：${file}`, 'ok');
    } catch (e) { toast.toast(String(e), 'error'); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>日志</h1>
          <div className="sub">启动器日志 + 游戏 latest.log；报障时一键导出诊断包</div>
        </div>
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={instanceId ?? ''} onChange={e => setInstanceId(e.target.value)}>
            <option value="">（不含游戏日志）</option>
            {instances.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button className="btn primary" onClick={exportDiag}>导出诊断包</button>
        </div>
      </div>

      <div className="row" style={{ alignItems: 'stretch', gap: 14 }}>
        <div className="panel" style={{ width: 280, flexShrink: 0, maxHeight: '70vh', overflow: 'auto' }}>
          <div className="panel-title">日志文件（{logs.length}）</div>
          {logs.length === 0 && <div className="faint">还没有日志。启动一次游戏后再来看。</div>}
          <div className="list">
            {logs.map(log => (
              <button key={log.name} className={`list-row`} style={{ width: '100%', textAlign: 'left', background: selected === log.name ? 'var(--accent-soft)' : 'transparent', borderRadius: 8, border: 'none', cursor: 'pointer', color: 'var(--text)' }} onClick={() => setSelected(log.name)}>
                <div style={{ minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{log.name}</div>
                  <div className="faint">{log.kind === 'game' ? '游戏' : '启动器'} · {formatBytes(log.sizeBytes)} · {timeAgo(log.mtime)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="panel" style={{ flex: 1, minWidth: 0 }}>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <input className="input" placeholder="在日志中搜索（如 error、mixin、OutOfMemory）…" value={query} onChange={e => setQuery(e.target.value)} />
            <span className="faint">{filtered.length} 行{query ? '匹配' : ''}</span>
          </div>
          <div className="mono" style={{ background: '#0b0e14', borderRadius: 8, padding: 12, height: '62vh', overflow: 'auto', fontSize: 11.5, lineHeight: 1.6 }}>
            {filtered.map((line, i) => {
              const cls = /error|exception|fail/i.test(line) ? 'var(--red)' : /warn/i.test(line) ? 'var(--amber)' : /\[mcl\]/.test(line) ? 'var(--accent)' : '#a9b4c8';
              return <div key={i} style={{ color: cls, whiteSpace: 'pre-wrap' }}>{line}</div>;
            })}
            {filtered.length === 0 && <div className="faint">没有匹配的内容</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
