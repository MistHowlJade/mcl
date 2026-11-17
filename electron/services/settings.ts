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
  return merged;
}

export function updateSettings(patch: any): AppSettings {
  const current = getSettings();
  // IPC/云快照传来的 patch 不一定是对象：null 会被 deepMerge 当成“整个设置变 null”
  const safePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const merged = deepMerge(current, safePatch);
  writeJson(paths.configFile(), merged);
  return merged;
}

export function resetSettings(): AppSettings {
  writeJson(paths.configFile(), DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS };
}
