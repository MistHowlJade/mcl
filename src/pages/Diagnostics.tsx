import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { formatBytes } from '../components/Modal';
import type { DownloadDiagnosticReport, DownloadSource } from '../../electron/shared/types';

const SOURCES: Array<{ id: DownloadSource; label: string; hint: string }> = [
  { id: 'auto', label: '自动（跟随测速）', hint: '优先使用测速更快的源' },
  { id: 'bmclapi', label: 'BMCLAPI', hint: '国内镜像' },
  { id: 'official', label: '官方源', hint: 'Mojang 官方' },
  { id: 'custom', label: '自定义镜像', hint: '使用设置里填写的地址' },
];

export default function Diagnostics() {
  const [report, setReport] = useState<DownloadDiagnosticReport | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const load = async () => {
    try { setReport(await api.downloadDiagReport()); }
    catch (e) { toast.toast(String(e), 'error'); }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, []);

  const probe = async () => {
    setBusy(true);
    try {
      const result = await api.downloadDiagProbe();
      setReport(result);
      toast.toast('测速完成，auto 模式已自动选择更快的源', 'ok');
    } catch (e) { toast.toast(String(e), 'error'); }
    finally { setBusy(false); }
  };

  const changeSource = async (source: DownloadSource) => {
    try {
      setReport(await api.downloadDiagSetSource(source));
      toast.toast(`下载源已切换为「${SOURCES.find(s => s.id === source)?.label ?? source}」`, 'ok');
    } catch (e) { toast.toast(String(e), 'error'); }
  };

  const clearCache = async () => {
    try {
      const result = await api.appClearCache();
      toast.toast(`已清理 ${result.removedFiles} 个缓存文件，释放 ${formatBytes(result.freedBytes)}`, 'ok');
      await load();
    } catch (e) { toast.toast(String(e), 'error'); }
  };

  if (!report) return <div className="empty"><div className="big"><Icon name="download" size={30} /></div>正在读取下载诊断信息…</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>下载诊断</h1>
          <div className="sub">镜像测速结果、当前生效源、代理状态与失败任务一目了然；修好后的 auto 模式会真正按测速选源。</div>
        </div>
        <div className="row">
          <button className="btn primary" onClick={probe} disabled={busy}>{busy ? '测速中…' : '重新测速'}</button>
          <button className="btn" onClick={() => api.appRevealFile(report.cacheDir).catch(e => toast.toast(String(e), 'error'))}>打开缓存目录</button>
          <button className="btn" onClick={clearCache}>清理缓存</button>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="panel">
          <div className="panel-title">下载源</div>
          <div className="row" style={{ marginBottom: 12 }}>
            <span className="faint">设置值</span><strong>{SOURCES.find(s => s.id === report.configuredSource)?.label ?? report.configuredSource}</strong>
            <span className="faint">实际生效</span><span className="tag green">{report.effectiveSource}</span>
          </div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {SOURCES.map(source => (
              <button key={source.id} className={`btn small ${report.configuredSource === source.id ? 'primary' : ''}`}
                title={source.hint} onClick={() => changeSource(source.id)}>{source.label}</button>
            ))}
          </div>
          <div className="faint" style={{ marginTop: 12, lineHeight: 1.7 }}>{report.recommendation}</div>
        </div>

        <div className="panel">
          <div className="panel-title">镜像测速</div>
          {report.health.length === 0 ? (
            <div className="faint">尚无测速记录，点「重新测速」开始。</div>
          ) : report.health.map(item => {
            const max = Math.max(1, ...report.health.map(h => h.latencyMs));
            return (
              <div key={item.source} style={{ marginBottom: 10 }}>
                <div className="row spread"><strong style={{ fontSize: 12 }}>{item.source}</strong><span className="faint">{item.ok ? `${item.latencyMs} ms` : '不可用'}</span></div>
                <div style={{ height: 7, background: 'var(--panel-2)', borderRadius: 4, overflow: 'hidden', marginTop: 4 }}>
                  <div style={{ height: '100%', width: `${item.ok ? Math.max(6, (1 - item.latencyMs / (max * 1.2)) * 100) : 0}%`, background: 'var(--accent)' }} />
                </div>
              </div>
            );
          })}
          <div className="faint" style={{ marginTop: 8 }}>
            上次测速：{report.lastTestAt ? new Date(report.lastTestAt).toLocaleString() : '从未'}
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 12 }}>
        <div className="panel">
          <div className="panel-title">网络与缓存</div>
          <div className="row spread"><span className="faint">代理</span><strong>{report.proxyEnabled ? (report.proxyAppliedToDownloads ? '已启用（作用于下载）' : '已启用（下载未走代理）') : '未启用'}</strong></div>
          <div className="row spread" style={{ marginTop: 8 }}><span className="faint">缓存占用</span><strong>{formatBytes(report.cacheSizeBytes)} · {report.cacheFiles} 个文件</strong></div>
          <div className="faint" style={{ marginTop: 10 }}>{report.cacheDir}</div>
        </div>

        <div className="panel">
          <div className="panel-title">最近失败任务</div>
          {report.recentFailures.length === 0 ? (
            <div className="faint">没有最近的下载失败记录。</div>
          ) : (
            <div className="list">
              {report.recentFailures.map((item, i) => (
                <div key={`${item.name}-${i}`} className="list-row">
                  <div className="list-icon"><Icon name="warn" size={16} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ fontSize: 12 }}>{item.name}</strong>
                    <div className="faint" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.error}</div>
                  </div>
                  <span className="faint">{new Date(item.finishedAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
