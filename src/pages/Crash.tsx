import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import type { CrashDiagnosis, CrashFix, InstanceInfo } from '../../electron/shared/types';

export default function Crash() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [instanceId, setInstanceId] = useState<string | null>(() => localStorage.getItem('mcl:selectedInstance'));
  const [diagnosis, setDiagnosis] = useState<CrashDiagnosis | null>(null);
  const [pasted, setPasted] = useState('');
  const [busyFix, setBusyFix] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    api.instancesList().then(list => {
      setInstances(list);
      if (!instanceId && list.length) setInstanceId(list[0].id);
    });
    /* eslint-disable-next-line */
  }, []);

  const analyzeLatest = async () => {
    if (!instanceId) return;
    try { setDiagnosis(await api.crashLatest(instanceId)); } catch (e) { toast.toast(String(e), 'error'); }
  };
  useEffect(() => { void analyzeLatest(); /* eslint-disable-next-line */ }, [instanceId]);

  const analyzePasted = async () => {
    if (!pasted.trim()) return;
    try { setDiagnosis(await api.crashAnalyzeText(pasted)); } catch (e) { toast.toast(String(e), 'error'); }
  };

  const applyFix = async (fix: CrashFix) => {
    if (!instanceId) return;
    setBusyFix(fix.id);
    try {
      const result = await api.crashFix(instanceId, fix);
      toast.toast(result.message, result.ok ? 'ok' : 'error');
    } catch (e) { toast.toast(String(e), 'error'); } finally { setBusyFix(null); }
  };

  const exportDiag = async () => {
    try {
      const file = await api.diagnosticExport(instanceId ?? undefined);
      if (file) { setExported(file); toast.toast('诊断包已导出，可直接附在 Issue 里', 'ok'); }
    } catch (e) { toast.toast(String(e), 'error'); }
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>崩溃分析</h1>
          <div className="sub">把几千行堆栈翻译成人话，顺便给你按钮修好它</div>
        </div>
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={instanceId ?? ''} onChange={e => setInstanceId(e.target.value)}>
            {instances.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button className="btn" onClick={analyzeLatest}>重新分析</button>
          <button className="btn" onClick={exportDiag}>导出诊断包</button>
        </div>
      </div>

      {diagnosis && (
        <div className={`panel diagnosis ${diagnosis.fixes[0]?.severity === 'high' ? 'high' : ''}`}>
          <div className="panel-title">{diagnosis.matched ? '🩺 诊断结果' : '❓ 未知崩溃'}</div>
          <h3>{diagnosis.title}</h3>
          <p style={{ margin: '8px 0', lineHeight: 1.7 }}>{diagnosis.summary}</p>
          <details style={{ marginTop: 6 }}>
            <summary className="faint" style={{ cursor: 'pointer' }}>技术细节（给熟悉 Mod 的朋友看）</summary>
            <p className="faint" style={{ marginTop: 6, lineHeight: 1.7 }}>{diagnosis.detail}</p>
            <div className="mono" style={{ marginTop: 8, background: '#0b0e14', borderRadius: 8, padding: 10, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{diagnosis.excerpt}</div>
            <div className="faint mt">来源：{diagnosis.sourceFile}</div>
          </details>
          {diagnosis.fixes.length > 0 && (
            <div className="mt">
              <div className="faint" style={{ marginBottom: 2 }}>一键修复：</div>
              {diagnosis.fixes.map(fix => (
                <div key={fix.id} className="fix-item">
                  <div style={{ flex: 1 }}>
                    <div className="fx-label">{fix.label}</div>
                    <div className="fx-desc">{fix.description}</div>
                  </div>
                  <button className="btn small primary" disabled={busyFix === fix.id} onClick={() => applyFix(fix)}>{busyFix === fix.id ? '处理中…' : '修复'}</button>
                </div>
              ))}
            </div>
          )}
          {exported && <div className="faint mt">诊断包已导出到：{exported}</div>}
        </div>
      )}

      <div className="panel">
        <div className="panel-title">手动分析日志</div>
        <textarea
          className="input mono"
          placeholder="把游戏崩溃时的日志 / crash-reports 里的内容粘贴到这里，例如：&#10;java.lang.OutOfMemoryError: Java heap space&#10;或者整段 latest.log"
          value={pasted}
          onChange={e => setPasted(e.target.value)}
        />
        <div className="row mt">
          <button className="btn primary" onClick={analyzePasted}>分析这段日志</button>
          <span className="faint">常见关键模式：UnsupportedClassVersionError（Java 版本）、OutOfMemoryError（内存）、Mixin apply failed（模组冲突）、Missing or unsupported mandatory dependencies（缺前置）</span>
        </div>
      </div>
    </div>
  );
}
