import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  const [maxBytes, setMaxBytes] = useState(1024 * 1024);
  const toast = useToast();
  const listSeq = useRef(0);
  const readSeq = useRef(0);

  useEffect(() => {
    api.instancesList().then(list => {
      setInstances(list);
      // localStorage 里的实例可能已被删除：失效时自动落到第一台
      setInstanceId(prev => (prev && list.some(i => i.id === prev)) ? prev : (list[0]?.id ?? null));
    }).catch(e => toast.toast(String(e), 'error'));
    /* eslint-disable-next-line */
  }, []);

  // 与首页/内容页共用同一个实例选择：切到别的页面后不应跳回旧实例
  useEffect(() => {
    if (instanceId) localStorage.setItem('mcl:selectedInstance', instanceId);
  }, [instanceId]);

  useEffect(() => {
    const seq = ++listSeq.current;
    api.logsList(instanceId ?? undefined).then(list => {
      if (seq !== listSeq.current) return;
      setLogs(list);
      // 切换实例后旧选中项可能不存在：自动落到第一条，避免右侧一直显示上一个实例的日志
      setSelected(prev => (prev && list.some(l => l.name === prev)) ? prev : (list[0]?.name ?? null));
    }).catch(() => {
      if (seq === listSeq.current) { setLogs([]); setSelected(null); setContent(''); }
    });
    /* eslint-disable-next-line */
  }, [instanceId]);

  useEffect(() => {
    const seq = ++readSeq.current;
    if (!selected) { setContent(''); return; }
    api.logsRead(selected, instanceId ?? undefined, maxBytes).then(text => {
      if (seq === readSeq.current) setContent(text);
    }).catch(e => {
      if (seq === readSeq.current) { setContent(''); toast.toast(String(e), 'error'); }
    });
    /* eslint-disable-next-line */
  }, [selected, instanceId, maxBytes]);

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
          <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <input className="input" placeholder="在日志中搜索…" value={query} onChange={e => setQuery(e.target.value)} />
            <button className="btn small" onClick={() => setQuery('error')}>error</button>
            <button className="btn small" onClick={() => setQuery('mixin')}>mixin</button>
            <button className="btn small" onClick={() => setQuery('OutOfMemory')}>OOM</button>
            {query && <button className="btn small ghost" onClick={() => setQuery('')}>清除</button>}
            <button className="btn small" onClick={() => setMaxBytes(b => Math.min(64 * 1024 * 1024, b * 4))} title="显示更早的日志内容（最多 64 MB）">显示更早</button>
            <span className="faint">已读取 {formatBytes(maxBytes)} · {filtered.length} 行{query ? '匹配' : ''}</span>
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
