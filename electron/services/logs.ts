/**
 * 日志查看服务：列出 / 读取 MCL 日志与实例 latest.log
 */
import * as fs from 'fs';
import * as path from 'path';
import * as paths from './paths';

export interface LogFileInfo {
  name: string;
  sizeBytes: number;
  mtime: number;
  /** 'launcher' | 'game' */
  kind: string;
}

export function listLogs(instanceId?: string | null): LogFileInfo[] {
  const out: LogFileInfo[] = [];
  // instanceId 来自渲染进程：非法 ID 当作“没有选实例”，避免 ../ 读到别处
  const validId = typeof instanceId === 'string' && /^[a-f0-9]{16}$/.test(instanceId) ? instanceId : null;
  if (fs.existsSync(paths.logsDir())) {
    for (const f of fs.readdirSync(paths.logsDir())) {
      if (!/\.(log|txt)$/i.test(f)) continue;
      const full = path.join(paths.logsDir(), f);
      try {
        const stat = fs.statSync(full);
        out.push({ name: f, sizeBytes: stat.size, mtime: stat.mtimeMs, kind: 'launcher' });
      } catch { /* 文件可能在列目录瞬间被清理 */ }
    }
  }
  if (validId) {
    const gameLog = path.join(paths.gameDir(validId), 'logs', 'latest.log');
    try {
      const stat = fs.statSync(gameLog);
      out.push({ name: 'latest.log (游戏)', sizeBytes: stat.size, mtime: stat.mtimeMs, kind: 'game' });
    } catch { /* 没有游戏日志 */ }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

export function readLog(name: string, instanceId?: string | null, maxBytes = 1024 * 1024): string {
  let full: string | null = null;
  const validId = typeof instanceId === 'string' && /^[a-f0-9]{16}$/.test(instanceId) ? instanceId : null;
  if (name === 'latest.log (游戏)' && validId) {
    full = path.join(paths.gameDir(validId), 'logs', 'latest.log');
  } else {
    // 只允许读取 logs 目录下的 .log/.txt，防止通过 ../ 读取任意文件
    const safe = path.basename(String(name ?? ''));
    if (!/\.(log|txt)$/i.test(safe)) throw new Error('日志不存在');
    const candidate = path.join(paths.logsDir(), safe);
    if (!fs.existsSync(candidate)) throw new Error('日志不存在');
    full = candidate;
  }
  if (!full) throw new Error('日志不存在');
  let stat: fs.Stats;
  try { stat = fs.statSync(full); } catch { throw new Error('日志不存在或已被删除'); }
  // maxBytes 由 IPC 传入：NaN/负数会让 slice 计算失效，统一兜底到 1 MB
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(Math.floor(maxBytes), 64 * 1024 * 1024) : 1024 * 1024;
  const start = Math.max(0, stat.size - limit);
  // 日志正在被游戏写入：stat 与 read 之间文件可能变短，
  // 按实际读到的字节数截断缓冲区，避免尾部留下一段 NUL 显示成乱码
  const buf = Buffer.alloc(stat.size - start);
  const fd = fs.openSync(full, 'r');
  let read = 0;
  try {
    read = fs.readSync(fd, buf, 0, buf.length, start);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return buf.subarray(0, read).toString('utf8');
}
