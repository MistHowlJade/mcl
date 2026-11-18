/**
 * 全局设置：类型安全 + 默认值 + 原子写
 */
import * as paths from './paths';
import { AppSettings } from '../shared/types';
import { readJson, writeJson } from './store';

export const DEFAULT_SETTINGS: AppSettings = {
  general: {
    zoomFactor: 1,
    autoBackupBeforeLaunch: true,
    backupKeep: 10,
    confirmBeforeLaunch: false,
    defaultResolution: { width: 1280, height: 720 },
  },
  download: {
    source: 'auto',
    customMirror: '',
    maxThreads: 16,
    segmentSizeMB: 4,
    timeoutMs: 15000,
    retries: 3,
  },
  java: {
    defaultPath: '',
  },
  launch: {
    autoKillResidual: true,
    log4jFix: true,
    utf8Encoding: true,
    showLogOnCrash: true,
    globalJvmArgs: '',
  },
  curseforge: {
    apiKey: '',
  },
  migration: {
    copyInsteadOfMove: true,
  },
  network: {
    proxyMode: 'off',
    proxyUrl: '',
    proxyUsername: '',
    proxyPassword: '',
    applyToDownloads: true,
    applyToGame: false,
  },
  cloud: {
    provider: 'off',
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    gistToken: '',
    gistId: '',
    includeSaves: false,
    lastSyncAt: null,
    lastSyncDirection: null,
  },
};

function deepMerge<T>(base: T, patch: any): T {
  // null 是合法值（如 defaultResolution = null 表示自动），不能用 base 覆盖
  if (patch === undefined) return base;
  if (patch === null) return null as T;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  const out: any = { ...(base as any) };
  for (const key of Object.keys(patch)) {
    // 云同步/手工编辑的配置可能带 __proto__ 等键，跳过以免污染对象原型
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = key in (base as any) ? deepMerge((base as any)[key], patch[key]) : patch[key];
  }
  return out;
}

const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const bool = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;
const num = (value: unknown, fallback: number, min: number, max: number, integer = false): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const clamped = Math.max(min, Math.min(max, value));
  return integer ? Math.round(clamped) : clamped;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? value as T : fallback;

/**
 * 逐字段归一化：配置文件/云快照里一个 null 或字符串就可能让下载、代理、启动参数整条链路抛错。
 * 关键字段类型不对时回退默认值，而不是把错误值继续传给业务层。
 */
function normalizeSettings(input: AppSettings): AppSettings {
  const s = input;
  s.general = {
    zoomFactor: num(s.general.zoomFactor, 1, 0.75, 2),
    autoBackupBeforeLaunch: bool(s.general.autoBackupBeforeLaunch, true),
    backupKeep: num(s.general.backupKeep, 10, 1, 200, true),
    confirmBeforeLaunch: bool(s.general.confirmBeforeLaunch, false),
    defaultResolution: s.general.defaultResolution && typeof s.general.defaultResolution === 'object'
      ? {
        width: num(s.general.defaultResolution.width, 1280, 320, 7680, true),
        height: num(s.general.defaultResolution.height, 720, 240, 4320, true),
      }
      : null,
  };
  s.download = {
    source: oneOf(s.download.source, ['auto', 'bmclapi', 'official', 'custom'] as const, 'auto'),
    customMirror: str(s.download.customMirror),
    maxThreads: num(s.download.maxThreads, 16, 1, 64, true),
    segmentSizeMB: num(s.download.segmentSizeMB, 4, 1, 512),
    timeoutMs: num(s.download.timeoutMs, 15000, 3000, 300000, true),
    retries: num(s.download.retries, 3, 0, 10, true),
  };
  s.java = { defaultPath: str(s.java.defaultPath) };
  s.launch = {
    autoKillResidual: bool(s.launch.autoKillResidual, true),
    log4jFix: bool(s.launch.log4jFix, true),
    utf8Encoding: bool(s.launch.utf8Encoding, true),
    showLogOnCrash: bool(s.launch.showLogOnCrash, true),
    globalJvmArgs: str(s.launch.globalJvmArgs),
  };
  s.curseforge = { apiKey: str(s.curseforge.apiKey) };
  s.migration = { copyInsteadOfMove: bool(s.migration.copyInsteadOfMove, true) };
  s.network = {
    proxyMode: oneOf(s.network.proxyMode, ['off', 'manual'] as const, 'off'),
    proxyUrl: str(s.network.proxyUrl),
    proxyUsername: str(s.network.proxyUsername),
    proxyPassword: str(s.network.proxyPassword),
    applyToDownloads: bool(s.network.applyToDownloads, true),
    applyToGame: bool(s.network.applyToGame, false),
  };
  s.cloud = {
    provider: oneOf(s.cloud.provider, ['off', 'webdav', 'gist'] as const, 'off'),
    webdavUrl: str(s.cloud.webdavUrl),
    webdavUsername: str(s.cloud.webdavUsername),
    webdavPassword: str(s.cloud.webdavPassword),
    gistToken: str(s.cloud.gistToken),
    gistId: str(s.cloud.gistId),
    includeSaves: bool(s.cloud.includeSaves, false),
    lastSyncAt: typeof s.cloud.lastSyncAt === 'number' && Number.isFinite(s.cloud.lastSyncAt) ? s.cloud.lastSyncAt : null,
    lastSyncDirection: s.cloud.lastSyncDirection === 'upload' || s.cloud.lastSyncDirection === 'download' ? s.cloud.lastSyncDirection : null,
  };
  return s;
}

export function getSettings(): AppSettings {
  const raw = readJson<unknown>(paths.configFile(), {});
  // 根节点必须是对象：config.json 写成 null/数组/字符串时直接回退默认，否则深合并会返回 null
  const patch = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<AppSettings> : {};
  const merged = deepMerge(DEFAULT_SETTINGS, patch);
  // config.json 可能被手工改坏（某分区变成 null/字符串）：回退默认分区，别让整个启动器崩掉
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AppSettings>) {
    const value = merged[key] as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      (merged as any)[key] = DEFAULT_SETTINGS[key];
    }
  }
  return normalizeSettings(merged);
}

export function updateSettings(patch: any): AppSettings {
  const current = getSettings();
  // IPC/云快照传来的 patch 不一定是对象：null 会被 deepMerge 当成“整个设置变 null”
  const safePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const merged = normalizeSettings(deepMerge(current, safePatch));
  writeJson(paths.configFile(), merged);
  return merged;
}

export function resetSettings(): AppSettings {
  writeJson(paths.configFile(), DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS };
}
