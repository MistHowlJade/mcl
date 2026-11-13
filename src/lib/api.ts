/**
 * 类型安全的窗口桥（对应 electron/preload.ts 暴露的 window.mcl）
 */
import type {
  Account, AppSettings, BackupInfo, CloudSnapshotInfo, ContentKind, ContentList,
  CrashDiagnosis, CrashFix, EnvironmentReport, ExportFormat, ExportResult, InstanceConfig,
  InstanceInfo, InstalledMod, JavaInfo, LaunchState, MigrationCandidate, MigrationPreview,
  MigrationResult, ModHealthIssue, ModSearchResult, ServerBackupInfo, ServerConfig, ServerInfo,
  ServerLoader, ServerProperties, UpdateInfo, VersionManifestEntry,
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

/** 本地图片预览地址（mcl-media:// 只允许读取 MCL 数据目录） */
export const mediaUrl = (filePath?: string | null): string | undefined =>
  filePath ? `mcl-media://local/?p=${encodeURIComponent(filePath)}` : undefined;

export interface CloudApplyResult {
  applied: boolean;
  settings: boolean;
  instances: number;
  servers: number;
  saves: number;
  warnings: string[];
}

export const api = {
  appInfo: () => invoke<{ name: string; version: string; dataDir: string; platform: string; arch: string }>('app:info'),
  appUpdateCheck: () => invoke<UpdateInfo>('app:updateCheck'),
  appCacheInfo: () => invoke<{ dir: string; sizeBytes: number; files: number }>('app:cacheInfo'),
  appClearCache: () => invoke<{ freedBytes: number; removedFiles: number }>('app:clearCache'),

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
  instanceExport: (id: string, format: ExportFormat) => invoke<ExportResult | null>('export:instance', id, format),

  launchStart: (instanceId: string, accountId?: string | null) => invoke<{ started: boolean }>('launch:start', instanceId, accountId),
  launchState: () => invoke<LaunchState>('launch:state'),
  launchKillResidual: () => invoke<{ killed: number[] }>('launch:killResidual'),

  accountsList: () => invoke<Account[]>('accounts:list'),
  accountsActive: () => invoke<Account | null>('accounts:active'),
  accountSetActive: (id: string) => invoke<boolean>('accounts:setActive', id),
  accountRemove: (id: string) => invoke<boolean>('accounts:remove', id),
  accountCreateOffline: (name: string, skinDataUrl?: string | null) => invoke<Account>('accounts:createOffline', name, skinDataUrl),
  accountsBeginMicrosoft: () => invoke<{ deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number; message: string }>('accounts:beginMicrosoft'),
  accountLocalSkin: (accountId: string, model: 'classic' | 'slim') => invoke<Account | null>('accounts:localSkin', accountId, model),
  accountClearLocalSkin: (accountId: string) => invoke<Account>('accounts:clearLocalSkin', accountId),
  accountLocalCape: (accountId: string) => invoke<Account | null>('accounts:localCape', accountId),
  accountClearLocalCape: (accountId: string) => invoke<Account>('accounts:clearLocalCape', accountId),
  accountMicrosoftSkin: (accountId: string, variant: 'classic' | 'slim') => invoke<Account | null>('accounts:microsoftSkin', accountId, variant),
  accountMicrosoftSkinReset: (accountId: string) => invoke<Account>('accounts:microsoftSkinReset', accountId),

  modrinthSearch: (query: string, opts: { loader?: string; gameVersion?: string; projectType?: 'mod' | 'modpack'; index?: 'relevance' | 'downloads' | 'follows' | 'updated' }) =>
    invoke<ModSearchResult[]>('modrinth:search', query, opts),
  modrinthInstalled: (instanceId: string) => invoke<InstalledMod[]>('modrinth:installed', instanceId),
  modrinthInstall: (instanceId: string, projectId: string, versionId: string | null, opts: { loader?: string; gameVersion?: string }) =>
    invoke<{ primary: InstalledMod; installed: InstalledMod[]; optionalDependencies: Array<{ projectId: string; title: string }> }>('modrinth:install', instanceId, projectId, versionId, opts),
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

  /* ---------- 服务器 ---------- */
  serversList: () => invoke<ServerInfo[]>('server:list'),
  serverGet: (id: string) => invoke<ServerInfo | null>('server:get', id),
  serverCreate: (input: { name: string; mcVersion: string; loader: ServerLoader; loaderVersion?: string | null; port?: number; memoryMB?: number; javaPath?: string | null }) =>
    invoke<ServerConfig>('server:create', input),
  serverUpdate: (id: string, patch: Partial<ServerConfig>) => invoke<ServerConfig>('server:update', id, patch),
  serverDelete: (id: string, backup?: boolean) => invoke<{ ok: boolean; backupPath?: string }>('server:delete', id, backup),
  serverPrepare: (id: string) => invoke<ServerInfo>('server:prepare', id),
  serverStart: (id: string) => invoke<ServerInfo>('server:start', id),
  serverStop: (id: string) => invoke<boolean>('server:stop', id),
  serverKill: (id: string) => invoke<boolean>('server:kill', id),
  serverSendCommand: (id: string, command: string) => invoke<boolean>('server:sendCommand', id, command),
  serverCheckPort: (port: number) => invoke<boolean>('server:checkPort', port),
  serverAcceptEula: (id: string) => invoke<ServerConfig>('server:acceptEula', id),
  serverProperties: (id: string) => invoke<ServerProperties>('server:properties', id),
  serverSaveProperties: (id: string, patch: ServerProperties) => invoke<ServerProperties>('server:saveProperties', id, patch),
  serverLog: (id: string, maxLines?: number) => invoke<string[]>('server:log', id, maxLines),
  serverOpenDir: (id: string) => invoke('server:openDir', id),
  serverBackups: (id: string) => invoke<ServerBackupInfo[]>('server:backups', id),
  serverBackup: (id: string, name?: string) => invoke<ServerBackupInfo>('server:backup', id, name),
  serverRestoreBackup: (id: string, name: string) => invoke<{ restoredFiles: number }>('server:restoreBackup', id, name),
  serverDeleteBackup: (id: string, name: string) => invoke<boolean>('server:deleteBackup', id, name),

  /* ---------- 云同步 ---------- */
  cloudTest: () => invoke<{ ok: boolean; message: string }>('cloud:test'),
  cloudInspect: () => invoke<CloudSnapshotInfo>('cloud:inspect'),
  cloudUpload: () => invoke<CloudSnapshotInfo>('cloud:upload'),
  cloudDownload: () => invoke<CloudApplyResult>('cloud:download'),

  /* ---------- 内容管理 ---------- */
  contentList: (instanceId: string) => invoke<ContentList>('content:list', instanceId),
  contentToggleResourcePack: (instanceId: string, fileName: string) => invoke<boolean>('content:toggleResourcePack', instanceId, fileName),
  contentToggleShaderPack: (instanceId: string, fileName: string) => invoke<boolean>('content:toggleShaderPack', instanceId, fileName),
  contentDelete: (instanceId: string, kind: ContentKind, fileName: string) => invoke<{ deleted: boolean; backupPath?: string }>('content:delete', instanceId, kind, fileName),
  contentBackupWorld: (instanceId: string, worldName: string, displayName?: string) => invoke<string>('content:backupWorld', instanceId, worldName, displayName),
  contentImportDialog: (instanceId: string, kind: ContentKind, mode?: 'file' | 'folder') => invoke<{ imported: number; skipped: string[] } | null>('content:importDialog', instanceId, kind, mode),
  contentOpenItem: (path: string) => invoke('content:openItem', path),
  contentOpenFolder: (instanceId: string, kind: ContentKind) => invoke('content:openFolder', instanceId, kind),
};

/* 事件订阅（返回取消函数） */
export const on = (channel: string, cb: (...args: any[]) => void) => window.mcl.on(channel, cb);
export type { EnvironmentReport };