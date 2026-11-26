import React, { useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/ui';
import { useInstanceSelection } from '../lib/hooks';
import type { PreflightCheck, PreflightReport } from '../../electron/shared/types';

const STATUS_TAG: Record<PreflightCheck['status'], string> = { ok: 'green', warn: 'amber', error: 'red' };
const STATUS_LABEL: Record<PreflightCheck['status'], string> = { ok: '正常', warn: '注意', error: '异常' };

export default function Preflight() {
  const { instances, instanceId, setInstanceId } = useInstanceSelection();
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [running, setRunning] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const toast = useToast();

  const run = async () => {
    if (!instanceId) return;
    setRunning(true);
    try {
      const result = await api.preflightRun(instanceId);
      setReport(result);
    } catch (e) { toast.toast(String(e), 'error'); }
    finally { setRunning(false); }
  };

  const fix = async (item: PreflightCheck) => {
    if (!instanceId || !item.fix) return;
    setFixing(item.id);
    try {
      const result = await api.preflightFix(instanceId, item.fix);
      toast.toast(result.message, result.ok ? 'ok' : 'error');
      if (result.ok) await run();
    } catch (e) { toast.toast(String(e), 'error'); }
    finally { setFixing(null); }
  };

  if (instances.length === 0) {
    return <EmptyState icon="shield" title="还没有实例" description="先创建一个实例，再做启动前预检。" />;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>启动前预检</h1>
          <div className="sub">把常见闪退原因前移：Java、内存、原生库、版本缓存、残留进程与目录权限，逐项给出人话和修复按钮。</div>
        </div>
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={instanceId ?? ''} onChange={e => { setInstanceId(e.target.value); setReport(null); }}>
            {instances.map(i => <option key={i.id} value={i.id}>{i.name}（{i.mcVersion} {i.loader}）</option>)}
          </select>
          <button className="btn primary" onClick={run} disabled={!instanceId || running}>{running ? '检查中…' : '开始预检'}</button>
        </div>
      </div>

      {!report ? (
        <div className="empty"><div className="big"><Icon name="shield" size={30} /></div>选择实例后点「开始预检」，结果会显示在这里。</div>
      ) : (
        <>
          <div className="panel" style={{ marginBottom: 14 }}>
            <div className="row spread">
              <div className="row" style={{ gap: 24 }}>
                <div><div className="faint">健康分</div><div style={{ fontSize: 24, fontWeight: 800 }}>{report.score}<span style={{ fontSize: 13, color: 'var(--ink-3)' }}> / 100</span></div></div>
                <div><div className="faint">检查项</div><div style={{ fontSize: 20, fontWeight: 800 }}>{report.checks.length}</div></div>
                <div><div className="faint">结论</div><div style={{ marginTop: 6 }}><span className={`tag ${report.ready ? 'green' : 'red'}`}>{report.ready ? '可以启动' : '建议先修复'}</span></div></div>
              </div>
              <div className="faint">{report.instanceName}</div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">检查明细</div>
            <div className="list">
              {report.checks.map(item => (
                <div key={item.id} className="list-row">
                  <div className="list-icon"><Icon name={item.status === 'ok' ? 'check' : item.status === 'warn' ? 'clock' : 'warn'} size={18} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ gap: 8 }}>
                      <strong style={{ fontSize: 13 }}>{item.label}</strong>
                      <span className={`tag ${STATUS_TAG[item.status]}`}>{STATUS_LABEL[item.status]}</span>
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 3 }}>{item.message}</div>
                    {item.detail && <div className="faint" style={{ whiteSpace: 'pre-wrap', marginTop: 3 }}>{item.detail}</div>}
                  </div>
                  {item.fix && (
                    <button className="btn small" disabled={fixing === item.id} onClick={() => fix(item)}>
                      {fixing === item.id ? '修复中…' : item.fix.label}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
