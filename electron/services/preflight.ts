/**
 * 启动前预检：把常见闪退原因前移到启动前，用人话提示并支持一键修复。
 * 只读为主；修复动作全部走现有服务，不在这里直接写游戏文件。
 */
import * as fs from 'fs';
import * as os from 'node:os';
import * as path from 'path';
import * as paths from './paths';
import * as instances from './instances';
import * as javaService from './java';
import * as minecraft from './minecraft';
import { getSettings } from './settings';
import { readJson } from './store';
import { PreflightCheck, PreflightReport, PreflightStatus } from '../shared/types';

const MEMORY_PRESET_MB: Record<string, { initial: number; max: number }> = {
  low: { initial: 512, max: 1024 },
  standard: { initial: 2048, max: 4096 },
  heavy: { initial: 4096, max: 8192 },
};

function check(id: string, label: string, status: PreflightStatus, message: string,
  detail?: string, fix?: PreflightCheck['fix']): PreflightCheck {
  return { id, label, status, message, detail, fix };
}

async function checkJava(instance: ReturnType<typeof instances.getInstance>): Promise<PreflightCheck> {
  if (!instance) return check('java', 'Java 环境', 'error', '实例不存在，无法检查 Java');
  const required = javaService.recommendedJavaMajor(instance.mcVersion);
  const javas = await javaService.detectSystemJavas();
  const override = instance.javaPath || getSettings().java.defaultPath;
  if (override && !fs.existsSync(override)) {
    return check('java', 'Java 环境', 'error', `指定的 Java 不存在：${override}`,
      `这个实例需要 Java ${required} 或更高版本。`, { action: 'fix:javaInstall', label: `自动安装 Java ${required}`, args: { major: required } });
  }
  const usable = javas.filter(j => j.major >= required);
  if (usable.length === 0) {
    return check('java', 'Java 环境', 'error', `没有找到可用的 Java ${required}+`,
      `检测到 ${javas.length} 个 Java，最高为 Java ${javas.reduce((m, j) => Math.max(m, j.major), 0) || '未知'}。Minecraft ${instance.mcVersion} 需要 Java ${required}。`,
      { action: 'fix:javaInstall', label: `自动安装 Java ${required}`, args: { major: required } });
  }
  const best = usable.sort((a, b) => b.major - a.major)[0];
  return check('java', 'Java 环境', 'ok', `已就绪：Java ${best.major}（${best.vendor}）`, best.path);
}

function checkMemory(instance: NonNullable<ReturnType<typeof instances.getInstance>>): PreflightCheck {
  const preset = MEMORY_PRESET_MB[instance.memoryPreset || 'standard'] || MEMORY_PRESET_MB.standard;
  const maxMB = instance.heapMaxMB && instance.heapInitialMB ? instance.heapMaxMB : preset.max;
  const totalMB = Math.floor(os.totalmem() / 1024 / 1024);
  if (maxMB > totalMB * 0.7) {
    return check('memory', '内存分配', 'error', `分配 ${maxMB} MB 超过本机内存的 70%（${totalMB} MB）`,
      '过大的堆会让系统开始换页，反而更容易卡死或被强杀。',
      { action: 'fix:memoryPreset', label: '改用「标准」内存预设', args: { preset: 'standard' } });
  }
  if (maxMB > totalMB * 0.5) {
    return check('memory', '内存分配', 'warn', `分配 ${maxMB} MB，占本机内存一半以上`,
      '大型整合包可以，但建议关闭其他占内存的程序。');
  }
  return check('memory', '内存分配', 'ok', `内存预设合理（最大 ${maxMB} MB / 本机 ${totalMB} MB）`);
}

function checkNatives(instanceId: string): PreflightCheck {
  const dir = paths.nativesRoot(instanceId);
  try {
    const files = fs.readdirSync(dir).filter(f => /\.(dll|so|dylib)$/i.test(f));
    if (!files.length) throw new Error('empty');
    return check('natives', '原生库', 'ok', `已就绪：${files.length} 个 natives 文件`);
  } catch {
    return check('natives', '原生库', 'warn', 'natives 尚未解压或已被清理',
      '首次启动会自动解压；如果之前启动失败，可以手动重新提取。',
      { action: 'fix:reextractNatives', label: '重新提取 natives' });
  }
}

function checkVersion(instance: NonNullable<ReturnType<typeof instances.getInstance>>): PreflightCheck {
  const id = instance.mcVersion;
  const file = path.join(paths.versionsDir(), id, `${id}.json`);
  if (!fs.existsSync(file)) {
    return check('version', '游戏文件', 'warn', `本地还没有 ${id} 的版本配置`, '首次启动会自动下载游戏文件，属于正常情况。');
  }
  return check('version', '游戏文件', 'ok', `${id} 的版本配置已缓存`);
}

function checkResidual(): PreflightCheck {
  let pids: unknown = [];
  try { pids = readJson<unknown>(paths.residualPidsFile(), []); } catch { /* ignore */ }
  const alive = Array.isArray(pids)
    ? pids.filter((pid): pid is number => typeof pid === 'number' && pid > 0).filter(pid => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      })
    : [];
  if (alive.length) {
    return check('residual', '残留进程', 'warn', `发现 ${alive.length} 个上次未退干净的游戏进程`,
      `PID：${alive.slice(0, 8).join('、')}。残留进程可能占用 natives 和存档。`,
      { action: 'fix:killResidual', label: '结束残留进程' });
  }
  return check('residual', '残留进程', 'ok', '没有发现残留游戏进程');
}

function checkInstanceDir(instanceId: string): PreflightCheck {
  const dir = paths.gameDir(instanceId);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return check('dir', '实例目录', 'ok', '游戏目录可写');
  } catch {
    return check('dir', '实例目录', 'error', '游戏目录不可写或不存在',
      `${dir}\n请检查磁盘权限或是否被安全软件锁定。`);
  }
}

export async function runPreflight(instanceId: string): Promise<PreflightReport> {
  const instance = instances.getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const checks: PreflightCheck[] = [
    await checkJava(instance),
    checkMemory(instance),
    checkNatives(instanceId),
    checkVersion(instance),
    checkResidual(),
    checkInstanceDir(instanceId),
  ];
  const score = Math.round(checks.reduce((sum, item) => sum + (item.status === 'ok' ? 100 : item.status === 'warn' ? 50 : 0), 0) / checks.length);
  return {
    instanceId,
    instanceName: instance.name,
    checkedAt: Date.now(),
    score,
    ready: checks.every(item => item.status !== 'error'),
    checks,
  };
}

export async function applyPreflightFix(instanceId: string, action: string, args: Record<string, any> = {}): Promise<{ ok: boolean; message: string }> {
  switch (action) {
    case 'fix:javaInstall': {
      const major = Number(args.major) || 17;
      const installed = await javaService.installJava(major);
      return { ok: true, message: `Java ${major} 已安装：${installed}` };
    }
    case 'fix:reextractNatives':
      minecraft.reextractNatives(instanceId);
      return { ok: true, message: 'natives 已重新提取' };
    case 'fix:killResidual': {
      const killed = await minecraft.killResidualProcesses();
      return { ok: true, message: killed.length ? `已结束 ${killed.length} 个残留进程` : '没有需要结束的进程' };
    }
    case 'fix:repairLibraries': {
      const result = await minecraft.repairLibraries(instanceId);
      return { ok: result.failed === 0, message: `库校验完成：修复 ${result.repaired} 个，失败 ${result.failed} 个` };
    }
    case 'fix:memoryPreset': {
      const preset = args.preset === 'low' || args.preset === 'heavy' ? args.preset : 'standard';
      instances.updateInstance(instanceId, { memoryPreset: preset, heapInitialMB: null, heapMaxMB: null });
      return { ok: true, message: `内存预设已切换为「${preset}」` };
    }
    default:
      throw new Error(`不支持的预检修复动作：${action}`);
  }
}
