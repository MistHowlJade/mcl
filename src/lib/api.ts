/**
 * 类型安全的窗口桥（对应 electron/preload.ts 暴露的 window.mcl）
 */
import type {
  Account, AppSettings, BackupInfo, CrashDiagnosis, CrashFix, EnvironmentReport,
  InstanceConfig, InstanceInfo, InstalledMod, JavaInfo, LaunchState, MigrationCandidate,
  MigrationPreview, MigrationResult, ModHealthIssue, ModSearchResult, VersionManifestEntry,
} from '../../electron/shared/types';

declare global {
  interface Window {
    mcl: {
      invoke: <T = any>(channel: string, ...args: any[]) => Promise<T>;
      on: (channel: string, callback: (...args: any[]) => void) => () => void;
    };
  }
}

const invoke = <T>(channel: string, ...args: any[]): Promise<T> => window.mcl.invoke<T>(channel, ...args);

export const api = {
  appInfo: () => invoke<{ name: string; version: string; dataDir: string; platform: string; arch: string }>('app:info'),

  windowMinimize: () => invoke('win:minimize'),
  windowToggleMaximize: () => invoke<boolean>('win:toggleMaximize'),
  windowIsMaximized: () => invoke<boolean>('win:isMaximized'),
  windowClose: () => invoke('win:close'),
  windowSetZoom: (factor: number) => invoke<boolean>('win:setZoom', factor),

  settingsGet: () => invoke<AppSettings>('settings:get'),
  settingsUpdate: (patch: any) => invoke<AppSettings>('settings:update', patch),
  settingsReset: () => invoke<AppSettings>('settings:reset'),

  openPath: (p: string) => invoke<string>('shell:openPath', p),
  openExternal: (url: string) => invoke('shell:openExternal', url),
  pickFolder: () => invoke<string | null>('dialog:pickFolder'),
  pickFile: (filters: Array<{ name: string; extensions: string[] }>) => invoke<string | null>('dialog:pickFile', filters),

  versionsList: () => invoke<Array<{ id: string; type: VersionManifestEntry['type']; releaseTime: string }>>('versions:list'),

  javaDetect: () => invoke<JavaInfo[]>('java:detect'),
  javaRecommended: (mcVersion: string) => invoke<{ major: number }>('java:recommended', mcVersion),
  javaInstall: (major: number) => invoke<string>('java:install', major),

  instancesList: () => invoke<InstanceInfo[]>('instances:list'),
  instanceGet: (id: string) => invoke<InstanceInfo | null>('instances:get', id),
  instanceCreate: (input: { name: string; mcVersion: string; loader: InstanceConfig['loader']; loaderVersion?: string | null; memoryPreset?: InstanceConfig['memoryPreset']; javaPath?: string | null }) =>
    invoke<InstanceConfig>('instances:create', input),
  instanceUpdate: (id: string, patch: any) => invoke<InstanceConfig | null>('instances:update', id, patch),
  instanceDelete: (id: string) => invoke<{ ok: boolean; backupPath?: string }>('instances:delete', id),
  instanceDiskUsage: (id: string) => invoke<{ instance: number; shared: number }>('instances:diskUsage', id),
  instanceOpenGameDir: (id: string) => invoke('instances:openGameDir', id),
  instanceOpenDir: (id: string) => invoke('instances:openInstanceDir', id),

  launchStart: (instanceId: string, accountId?: string | null) => invoke<{ started: boolean }>('launch:start', instanceId, accountId),
  launchState: () => invoke<LaunchState>('launch:state'),
  launchKillResidual: () => invoke<{ killed: number[] }>('launch:killResidual'),

  accountsList: () => invoke<Account[]>('accounts:list'),
  accountsActive: () => invoke<Account | null>('accounts:active'),
  accountSetActive: (id: string) => invoke<boolean>('accounts:setActive', id),
  accountRemove: (id: string) => invoke<boolean>('accounts:remove', id),
  accountCreateOffline: (name: string, skinDataUrl?: string | null) => invoke<Account>('accounts:createOffline', name, skinDataUrl),
  accountsBeginMicrosoft: () => invoke<{ deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number; message: string }>('accounts:beginMicrosoft'),
  accountImportSkinFile: (accountId: string) => invoke<string | null>('accounts:importSkinFile', accountId),

  modrinthSearch: (query: string, opts: { loader?: string; gameVersion?: string; projectType?: 'mod' | 'modpack'; index?: 'relevance' | 'downloads' | 'follows' | 'updated' }) =>
    invoke<ModSearchResult[]>('modrinth:search', query, opts),
  modrinthInstalled: (instanceId: string) => invoke<InstalledMod[]>('modrinth:installed', instanceId),
  modrinthInstall: (instanceId: string, projectId: string, versionId: string | null, opts: { loader?: string; gameVersion?: string }) =>
    invoke<InstalledMod>('modrinth:install', instanceId, projectId, versionId, opts),
  modrinthCheckUpdates: (instanceId: string, mcVersion: string, loader?: string) => invoke<InstalledMod[]>('modrinth:checkUpdates', instanceId, mcVersion, loader),
  modrinthUpdateMod: (instanceId: string, fileName: string) => invoke<InstalledMod>('modrinth:updateMod', instanceId, fileName),
  modrinthToggle: (instanceId: string, fileName: string) => invoke<boolean>('modrinth:toggle', instanceId, fileName),

  modsHealth: (instanceId: string) => invoke<{ instanceId: string; scanned: number; issues: ModHealthIssue[] }>('mods:health', instanceId),
  modsHealthFix: (instanceId: string, target: string) => invoke<boolean>('mods:healthFix', instanceId, target),
  modsOpenFolder: (instanceId: string) => invoke('mods:openFolder', instanceId),

  modpackImportDialog: (targetName?: string) => invoke<any>('modpack:importDialog', targetName),
  modpackImportFile: (filePath: string, targetName?: string) => invoke<any>('modpack:importFile', filePath, targetName),

  backupList: (instanceId: string) => invoke<BackupInfo[]>('backup:list', instanceId),
  backupCreate: (instanceId: string, name?: string) => invoke<BackupInfo | null>('backup:create', instanceId, name),
  backupDelete: (backupId: string) => invoke<boolean>('backup:delete', backupId),
  backupRestore: (backupId: string, instanceId: string) => invoke<{ restoredFiles: number }>('backup:restore', backupId, instanceId),

  crashLatest: (instanceId: string) => invoke<CrashDiagnosis>('crash:latest', instanceId),
  crashAnalyzeText: (text: string) => invoke<CrashDiagnosis>('crash:analyzeText', text),
  crashFix: (instanceId: string, fix: CrashFix) => invoke<{ ok: boolean; message: string }>('crash:fix', instanceId, fix),

  migrateDetect: () => invoke<MigrationCandidate[]>('migrate:detect'),
  migratePreview: (root: string) => invoke<MigrationPreview>('migrate:preview', root),
  migrateImport: (root: string, selectedNames?: string[]) => invoke<MigrationResult>('migrate:import', root, selectedNames),

  logsList: (instanceId?: string | null) => invoke<Array<{ name: string; sizeBytes: number; mtime: number; kind: string }>>('logs:list', instanceId ?? null),
  logsRead: (name: string, instanceId?: string | null) => invoke<string>('logs:read', name, instanceId ?? null),

  diagnosticExport: (instanceId?: string | null) => invoke<string | null>('diagnostic:export', instanceId ?? null),
  mirrorTest: () => invoke<{ source: string; latencies: Array<{ source: string; latencyMs: number; ok: boolean }> }>('mirror:test'),
};

/* 事件订阅（返回取消函数） */
export const on = (channel: string, cb: (...args: any[]) => void) => window.mcl.on(channel, cb);
export type { EnvironmentReport };
