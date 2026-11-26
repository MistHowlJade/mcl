import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { formatBytes, timeAgo } from '../components/Modal';
import { useAsyncList, useInstanceSelection } from '../lib/hooks';
import type { CrashDiagnosis } from '../../electron/shared/types';

interface LogEntry { name: string; sizeBytes: number; mtime: number; kind: string }
type Level = 'all' | 'error' | 'warn' | 'info';

export default function Logs() {
  const { instances, instanceId, setInstanceId } = useInstanceSelection();
  const { items: logs } = useAsyncList<LogEntry>(
    () => api.logsList(instanceId ?? undefined),
    [instanceId],
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<Level>('all');
  const [useRegex, setUseRegex] = useState(false);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [diagnosis, setDiagnosis] = useState<CrashDiagnosis | null>(null);
  const [maxBytes, setMaxBytes] = useState(1024 * 1024);
  const toast = useToast();
  const readSeq = useRef(0);

  useEffect(() => {
    setSelected(prev => (prev && logs.some(l => l.name === prev)) ? prev : (logs[0]?.name ?? null));
  }, [logs]);

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

  useEffect(() => { setSelectedLine(null); setDiagnosis(null); }, [query, level, useRegex, content]);

  const invalidRegex = useMemo(() => {
    if (!useRegex || !query.trim()) return false;
    try { new RegExp(query, 'i'); return false; } catch { return true; }
  }, [query, useRegex]);

  const filtered = useMemo(() => {
    let lines = content.split(/\r?\n/);
    if (level === 'error') lines = lines.filter(l => /error|exception|fail/i.test(l));
    else if (level === 'warn') lines = lines.filter(l => /warn/i.test(l));
    else if (level === 'info') lines = lines.filter(l => /\[(info|mcl)\]/i.test(l));
    if (!query.trim() || invalidRegex) return lines;
    if (useRegex) {
      const re = new RegExp(query, 'i');
      return lines.filter(l => re.test(l));
    }
    const q = query.toLowerCase();
    return lines.filter(l => l.toLowerCase().includes(q));
  }, [content, query, level, useRegex, invalidRegex]);

  const highlight = (line: string): React.ReactNode => {
    if (!query.trim() || invalidRegex) return line;
    if (useRegex) {
      const match = line.match(new RegExp(query, 'i'));
      if (!match || match.index === undefined) return line;
      return <>{line.slice(0, match.index)}<mark>{match[0]}</mark>{line.slice(match.index + match[0].length)}</>;
    }
    const q = query.toLowerCase();
    const index = line.toLowerCase().indexOf(q);
    if (index < 0) return line;
    return <>{line.slice(0, index)}<mark>{line.slice(index, index + q.length)}</mark>{line.slice(index + q.length)}</>;
  };

  const analyzeSelected = async () => {
    if (selectedLine === null || !filtered[selectedLine]) return;
    try { setDiagnosis(await api.crashAnalyzeText(filtered[selectedLine])); }
    catch (e) { toast.toast(String(e), 'error'); }
  };

  const copySnippet = async () => {
    const text = selectedLine !== null && filtered[selectedLine]
      ? filtered[selectedLine]
      : filtered.join('\n');
    try {
      const ok = await api.copyText(text);
      toast.toast(ok ? '已复制到剪贴板' : '复制失败', ok ? 'ok' : 'error');
    } catch (e) { toast.toast(String(e), 'error'); }
  };

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
          <h1>日志智能诊断</h1>
          <div className="sub">级别过滤、关键词 / 正则搜索与高亮；选中任意一行可直接跑崩溃归因，并一键复制脱敏片段。</div>
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
              <button key={log.name} className="list-row" style={{ width: '100%', textAlign: 'left', background: selected === log.name ? 'var(--accent-soft)' : 'transparent', borderRadius: 8, border: 'none', cursor: 'pointer', color: 'var(--text)' }} onClick={() => setSelected(log.name)}>
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
            <input className="input" placeholder={useRegex ? '正则表达式…' : '在日志中搜索…'} value={query} onChange={e => setQuery(e.target.value)} />
            <button className="btn small" onClick={() => setQuery('error')}>error</button>
            <button className="btn small" onClick={() => setQuery('mixin')}>mixin</button>
            <button className="btn small" onClick={() => setQuery('OutOfMemory')}>OOM</button>
            <label className="row" style={{ gap: 4 }}><input type="checkbox" checked={useRegex} onChange={e => setUseRegex(e.target.checked)} />正则</label>
            {query && <button className="btn small ghost" onClick={() => setQuery('')}>清除</button>}
            <button className="btn small" onClick={() => setMaxBytes(b => Math.min(64 * 1024 * 1024, b * 4))} title="显示更早的日志内容（最多 64 MB）">显示更早</button>
          </div>

          <div className="tag-filter-row">
            {([['all', '全部'], ['error', '错误'], ['warn', '警告'], ['info', '信息']] as Array<[Level, string]>).map(([id, label]) => (
              <button key={id} className={`tag-chip ${level === id ? 'active' : ''}`} onClick={() => setLevel(id)}>{label}</button>
            ))}
            <span className="faint">已读取 {formatBytes(maxBytes)} · {filtered.length} 行</span>
          </div>
          {invalidRegex && <div className="faint" style={{ color: 'var(--red)', marginBottom: 6 }}>正则表达式不合法，已暂时显示全部匹配级别的行。</div>}

          <div className="mono" style={{ background: 'var(--panel-2)', borderRadius: 8, padding: 12, height: '50vh', overflow: 'auto', fontSize: 11.5, lineHeight: 1.6 }}>
            {filtered.map((line, i) => {
              const cls = /error|exception|fail/i.test(line) ? 'var(--red)' : /warn/i.test(line) ? 'var(--amber)' : /\[mcl\]/i.test(line) ? 'var(--accent)' : 'var(--ink-3)';
              return (
                <div key={i} onClick={() => setSelectedLine(i)}
                  style={{ color: cls, whiteSpace: 'pre-wrap', cursor: 'pointer', padding: '1px 4px', background: selectedLine === i ? 'var(--accent-soft)' : 'transparent', borderRadius: 4 }}>
                  {highlight(line)}
                </div>
              );
            })}
            {filtered.length === 0 && <div className="faint">没有匹配的内容</div>}
          </div>

          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btn small primary" onClick={analyzeSelected} disabled={selectedLine === null}>分析选中行</button>
            <button className="btn small" onClick={copySnippet}>复制{selectedLine !== null ? '选中行' : '全部匹配行'}</button>
            {selectedLine !== null && <span className="faint">选中第 {selectedLine + 1} 行：{filtered[selectedLine]?.slice(0, 120)}</span>}
          </div>

          {diagnosis && (
            <div className="panel" style={{ marginTop: 10, boxShadow: 'none' }}>
              <div className="panel-title">归因结果 <span className={`tag ${diagnosis.matched ? 'amber' : ''}`}>{diagnosis.matched ? diagnosis.title : '未匹配已知模式'}</span></div>
              <div style={{ fontSize: 12.5, lineHeight: 1.8 }}>{diagnosis.summary}</div>
              <div className="faint" style={{ marginTop: 6, lineHeight: 1.7 }}>{diagnosis.detail}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
