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
  if (patch === null || patch === undefined) return base;
  if (typeof base !== 'object' || Array.isArray(base)) return patch as T;
  const out: any = { ...(base as any) };
  for (const key of Object.keys(patch)) {
    out[key] = key in (base as any) ? deepMerge((base as any)[key], patch[key]) : patch[key];
  }
  return out;
}

export function getSettings(): AppSettings {
  const raw = readJson<Partial<AppSettings>>(paths.configFile(), {});
  return deepMerge(DEFAULT_SETTINGS, raw);
}

export function updateSettings(patch: any): AppSettings {
  const current = getSettings();
  const merged = deepMerge(current, patch);
  writeJson(paths.configFile(), merged);
  return merged;
}

export function resetSettings(): AppSettings {
  writeJson(paths.configFile(), DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS };
}
