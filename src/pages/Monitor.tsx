import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmModal, formatBytes } from '../components/Modal';
import { Icon } from '../components/Icon';
import type { MonitorStatus } from '../../electron/shared/types';

const STATUS_LABEL: Record<string, string> = {
  idle: '未启动', preparing: '准备中', downloading: '下载游戏文件', launching: '正在启动', running: '运行中', crashed: '异常退出', exited: '已退出',
};

function formatUptime(seconds: number | null): string {
  if (!Number.isFinite(seconds) || seconds === null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

export default function Monitor() {
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [confirmKill, setConfirmKill] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await api.monitorStatus();
        if (!active) return;
        setStatus(next);
        setLines(next.instanceId ? await api.monitorLogTail(next.instanceId, 120) : []);
      } catch { /* 轮询失败不打断界面 */ }
    };
    void refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const kill = async () => {
    setConfirmKill(false);
    try {
      const ok = await api.monitorKill();
      toast.toast(ok ? '已结束游戏进程' : '没有可结束的游戏进程', ok ? 'ok' : 'info');
    } catch (e) { toast.toast(String(e), 'error'); }
  };

  const running = status?.status === 'running' && !!status.metrics?.alive;
  const metrics = status?.metrics;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>运行监控</h1>
          <div className="sub">实时查看 MCL 启动的游戏进程资源占用与最新日志；每 2 秒自动刷新。</div>
        </div>
        <div className="row">
          <span className={`tag ${running ? 'green' : 'faint'}`}>{STATUS_LABEL[status?.status ?? 'idle'] ?? status?.status ?? '未启动'}</span>
          <button className="btn danger" disabled={!running} onClick={() => setConfirmKill(true)}>结束游戏</button>
        </div>
      </div>

      <div className="grid cols-3">
        <div className="panel">
          <div className="panel-title">CPU</div>
          <div style={{ fontSize: 26, fontWeight: 800 }}>{metrics?.cpuPercent != null ? `${metrics.cpuPercent.toFixed(1)}%` : '—'}</div>
          <div className="faint" style={{ marginTop: 6 }}>{metrics?.alive ? `PID ${metrics.pid}` : '没有运行中的游戏进程'}</div>
        </div>
        <div className="panel">
          <div className="panel-title">内存</div>
          <div style={{ fontSize: 26, fontWeight: 800 }}>{metrics?.memoryMB != null ? `${metrics.memoryMB} MB` : '—'}</div>
          <div className="faint" style={{ marginTop: 6 }}>{metrics?.memoryMB != null ? formatBytes(metrics.memoryMB * 1024 * 1024) : 'Linux 读取 RSS / Windows 读取工作集'}</div>
        </div>
        <div className="panel">
          <div className="panel-title">运行时长</div>
          <div style={{ fontSize: 26, fontWeight: 800 }}>{formatUptime(metrics?.uptimeSeconds ?? null)}</div>
          <div className="faint" style={{ marginTop: 6 }}>{status?.message || '仅统计由 MCL 启动的进程'}</div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel-title">游戏日志尾部 <span className="faint">最近 {lines.length} 行</span></div>
        <div className="mono" style={{ background: 'var(--panel-2)', borderRadius: 8, padding: 12, height: '52vh', overflow: 'auto', fontSize: 11.5, lineHeight: 1.6 }}>
          {lines.length === 0 ? <div className="faint">游戏运行后，这里会显示 latest.log 的尾部。</div> : lines.map((line, i) => {
            const color = /error|exception|fail/i.test(line) ? 'var(--red)' : /warn/i.test(line) ? 'var(--amber)' : 'var(--ink-3)';
            return <div key={i} style={{ color, whiteSpace: 'pre-wrap' }}>{line}</div>;
          })}
        </div>
      </div>

      {confirmKill && (
        <ConfirmModal
          title="结束游戏进程"
          message="将强制结束当前由 MCL 启动的游戏进程。未保存的进度可能丢失，确定继续吗？"
          confirmText="强制结束"
          danger
          onCancel={() => setConfirmKill(false)}
          onConfirm={kill}
        />
      )}
    </div>
  );
}
