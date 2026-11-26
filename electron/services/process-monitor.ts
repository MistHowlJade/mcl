/**
 * 游戏运行监控：读取游戏进程 CPU / 内存 / 运行时长，并提供日志尾部与紧急结束。
 * 只观察 launchState 里由 MCL 启动的 PID，不会扫描或结束无关进程。
 */
import { execFile } from 'child_process';
import * as minecraft from './minecraft';
import * as logsService from './logs';
import { MonitorStatus, ProcessMetrics } from '../shared/types';

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 4000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout ?? ''));
    });
  });
}

function parseEtime(raw: string): number | null {
  const text = raw.trim();
  const match = text.match(/(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

export async function getMetrics(pid: number): Promise<ProcessMetrics | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch { return null; }

  try {
    if (process.platform === 'win32') {
      const output = await runCommand('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      const row = output.split(/\r?\n/).find(line => line.includes(`"${pid}"`));
      if (!row) return null;
      const columns = row.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(s => s.replace(/^"|"$/g, '').trim());
      const mem = columns.find(c => /[\d,]+\s+K$/i.test(c));
      const memoryMB = mem ? Math.round(parseFloat(mem.replace(/[,\sK]/gi, '')) / 1024) : null;
      return { pid, cpuPercent: null, memoryMB, uptimeSeconds: null, alive: true };
    }

    const output = await runCommand('ps', ['-p', String(pid), '-o', '%cpu=,rss=,etime=']);
    const parts = output.trim().split(/\s+/);
    if (parts.length < 3) return null;
    return {
      pid,
      cpuPercent: Number.isFinite(Number(parts[0])) ? Number(parts[0]) : null,
      memoryMB: Number.isFinite(Number(parts[1])) ? Math.round(Number(parts[1]) / 1024) : null,
      uptimeSeconds: parseEtime(parts.slice(2).join(' ')),
      alive: true,
    };
  } catch {
    return null;
  }
}

export async function getStatus(): Promise<MonitorStatus> {
  const state = minecraft.launchState;
  const busy = ['preparing', 'downloading', 'launching', 'running'].includes(state.status);
  const pid = busy ? (state.pid ?? 0) : 0;
  return {
    instanceId: state.instanceId,
    status: state.status,
    message: state.message,
    metrics: pid ? await getMetrics(pid) : null,
  };
}

export function getLogTail(instanceId: string, maxLines = 120): string[] {
  if (!/^[a-f0-9]{16}$/.test(instanceId)) return [];
  try {
    const text = logsService.readLog('latest.log (游戏)', instanceId, 64 * 1024);
    return text.split(/\r?\n/).filter(line => line.trim()).slice(-Math.max(10, Math.min(400, maxLines)));
  } catch {
    return [];
  }
}

export async function killGame(): Promise<boolean> {
  const pid = minecraft.launchState.pid ?? 0;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform === 'win32') {
    try {
      await runCommand('taskkill', ['/PID', String(pid), '/T', '/F']);
      return true;
    } catch {
      return false;
    }
  }
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}
