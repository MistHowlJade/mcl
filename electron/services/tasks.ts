/**
 * 下载任务中心：把启动器发起的所有下载/安装汇总成一份可查看的清单。
 * - 只持久化任务元数据（名字、进度、时间、结果），不缓存任何下载内容
 * - 进度由各业务在已有回调里上报，不改动下载引擎本身
 * - 失败/完成状态写盘，重启启动器后仍能看到最近发生过什么
 */
import { EventEmitter } from 'events';
import * as paths from './paths';
import { readJson, writeJson } from './store';
import { DownloadTaskInfo, TaskAction, TaskKind, TaskStatus } from '../shared/types';

const MAX_TASKS = 60;
const KINDS: TaskKind[] = ['launch', 'mod', 'resourcepack', 'shader', 'world', 'modpack', 'java', 'update', 'server', 'other'];
const STATUSES: TaskStatus[] = ['running', 'done', 'failed', 'canceled'];

function isAction(value: unknown): value is TaskAction {
  if (!value || typeof value !== 'object') return false;
  const a = value as Record<string, unknown>;
  if (a.openDir !== undefined && typeof a.openDir !== 'string') return false;
  if (a.revealFile !== undefined && typeof a.revealFile !== 'string') return false;
  if (a.retry !== undefined) {
    if (!a.retry || typeof a.retry !== 'object') return false;
    const r = a.retry as Record<string, unknown>;
    if (r.type === 'update') return true;
    if (r.type === 'java') return Number.isInteger(r.major);
    if (r.type === 'modpack') return typeof r.filePath === 'string';
    if (r.type === 'launch') return typeof r.instanceId === 'string';
    return false;
  }
  return true;
}

/** 磁盘里的旧记录可能来自手工编辑/旧版本：逐字段校验后再进入内存，避免界面崩掉 */
function normalizeTask(value: unknown): DownloadTaskInfo | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as Record<string, unknown>;
  if (typeof t.id !== 'string' || typeof t.name !== 'string') return null;
  if (!KINDS.includes(t.kind as TaskKind) || !STATUSES.includes(t.status as TaskStatus)) return null;
  const num = (v: unknown, fallback = 0) => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  const out: DownloadTaskInfo = {
    id: t.id,
    name: t.name.slice(0, 200),
    kind: t.kind as TaskKind,
    status: t.status as TaskStatus,
    bytesDone: num(t.bytesDone),
    bytesTotal: num(t.bytesTotal),
    speed: num(t.speed),
    startedAt: num(t.startedAt, Date.now()),
  };
  if (typeof t.finishedAt === 'number') out.finishedAt = t.finishedAt;
  // 取消回调只存在于本次进程内，重启后不能再取消旧任务
  out.cancelable = false;
  if (typeof t.error === 'string') out.error = t.error.slice(0, 500);
  if (isAction(t.action)) out.action = t.action;
  // 上次启动时被强制关闭的「运行中」任务没有结束回合，标成取消，避免永远转圈
  if (out.status === 'running') out.status = 'canceled';
  return out;
}

class DownloadTasks extends EventEmitter {
  private tasks: DownloadTaskInfo[] = [];
  private loaded = false;
  /** 相邻两次进度的采样点，用来估算瞬时速度 */
  private samples = new Map<string, { at: number; done: number }>();
  /** 内存中的取消回调：不写盘，进程重启后自然失效 */
  private cancelers = new Map<string, () => void>();

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    const raw = readJson<unknown>(paths.tasksFile(), []);
    this.tasks = Array.isArray(raw)
      ? raw.map(normalizeTask).filter((t): t is DownloadTaskInfo => !!t).slice(0, MAX_TASKS)
      : [];
  }

  private persist(): void {
    try { writeJson(paths.tasksFile(), this.tasks.slice(0, MAX_TASKS)); } catch { /* 记录写失败不影响下载本身 */ }
  }

  private changed(): void { this.emit('changed'); }

  list(): DownloadTaskInfo[] {
    this.ensureLoaded();
    return this.tasks.map(t => ({ ...t }));
  }

  /** 开始一个任务，返回 id 供后续上报 */
  begin(kind: TaskKind, name: string, action?: TaskAction): string {
    this.ensureLoaded();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const task: DownloadTaskInfo = {
      id,
      name: String(name ?? '').slice(0, 200) || '下载任务',
      kind: KINDS.includes(kind) ? kind : 'other',
      status: 'running',
      bytesDone: 0,
      bytesTotal: 0,
      speed: 0,
      startedAt: Date.now(),
    };
    if (isAction(action)) task.action = action;
    this.tasks.unshift(task);
    this.tasks = this.tasks.slice(0, MAX_TASKS);
    this.samples.set(id, { at: Date.now(), done: 0 });
    this.persist();
    this.changed();
    return id;
  }

  /** 登记本次进程内可取消的任务（如游戏文件下载） */
  setCanceler(id: string, cancel: () => void): void {
    const task = this.tasks.find(t => t.id === id);
    if (!task || task.status !== 'running') return;
    this.cancelers.set(id, cancel);
    task.cancelable = true;
    this.changed();
  }

  /** 传输进度：total 可以后到（HEAD 探测后），只增不减地记录 */
  progress(id: string, bytesDone: number, bytesTotal?: number): void {
    const task = this.tasks.find(t => t.id === id);
    if (!task || task.status !== 'running') return;
    const done = Number.isFinite(bytesDone) && bytesDone >= 0 ? bytesDone : task.bytesDone;
    if (typeof bytesTotal === 'number' && Number.isFinite(bytesTotal) && bytesTotal >= 0) {
      task.bytesTotal = bytesTotal;
    }
    const now = Date.now();
    const last = this.samples.get(id) ?? { at: now - 200, done: task.bytesDone };
    const elapsed = now - last.at;
    if (elapsed >= 200 && done >= last.done) {
      // 平滑一下：相邻采样间隔太短时速度会跳得厉害
      task.speed = Math.round(((done - last.done) * 1000) / elapsed);
      this.samples.set(id, { at: now, done });
    }
    task.bytesDone = done;
    this.changed();
  }

  /** 给没有精确字节流任务用的简单进度：直接把总量视为已完成 */
  done(id: string, action?: TaskAction): void {
    const task = this.tasks.find(t => t.id === id);
    if (!task || task.status !== 'running') return;
    task.status = 'done';
    task.bytesDone = task.bytesTotal > 0 ? task.bytesTotal : task.bytesDone;
    task.speed = 0;
    task.finishedAt = Date.now();
    if (isAction(action)) task.action = { ...(task.action ?? {}), ...action };
    task.cancelable = false;
    this.samples.delete(id);
    this.cancelers.delete(id);
    this.persist();
    this.changed();
  }

  fail(id: string, error: string, action?: TaskAction): void {
    const task = this.tasks.find(t => t.id === id);
    if (!task || task.status !== 'running') return;
    task.status = 'failed';
    task.error = String(error ?? '未知错误').slice(0, 500);
    task.speed = 0;
    task.finishedAt = Date.now();
    if (isAction(action)) task.action = { ...(task.action ?? {}), ...action };
    task.cancelable = false;
    this.samples.delete(id);
    this.cancelers.delete(id);
    this.persist();
    this.changed();
  }

  cancel(id: string): void {
    const task = this.tasks.find(t => t.id === id);
    if (!task || task.status !== 'running') return;
    const cancel = this.cancelers.get(id);
    this.cancelers.delete(id);
    task.cancelable = false;
    if (cancel) {
      try { cancel(); } catch { /* 取消失败也不影响记录状态 */ }
    }
    task.status = 'canceled';
    task.speed = 0;
    task.finishedAt = Date.now();
    this.samples.delete(id);
    this.persist();
    this.changed();
  }

  clearFinished(): void {
    this.ensureLoaded();
    this.tasks = this.tasks.filter(t => t.status === 'running');
    this.persist();
    this.changed();
  }

  remove(id: string): void {
    this.tasks = this.tasks.filter(t => t.id !== id);
    this.samples.delete(id);
    this.cancelers.delete(id);
    this.persist();
    this.changed();
  }
}

export const downloadTasks = new DownloadTasks();
