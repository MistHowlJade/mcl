/**
 * MCL 共享类型定义（主进程 / 渲染进程共用）
 */

export type LoaderType = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge';
export type MemoryPreset = 'low' | 'standard' | 'heavy';

export interface InstanceConfig {
  id: string;
  name: string;
  mcVersion: string;
  loader: LoaderType;
  loaderVersion?: string | null;
  /** 每个实例独立的 Java 路径；为空则使用全局规则（自动匹配/自动下载） */
  javaPath?: string | null;
  /** 内存预设：低配 / 标准 / 大型整合包·光影 */
  memoryPreset?: MemoryPreset | null;
  /** 自定义 JVM 附加参数（空格分隔或每行一条） */
  jvmArgsExtra?: string;
  /** 该实例禁止自动更新 Mod（整合包玩家保护） */
  noModUpdate?: boolean;
  resolution?: { width: number; height: number } | null;
  createdAt: number;
  lastPlayedAt?: number | null;
  playTimeSeconds?: number;
}

export interface InstanceInfo extends InstanceConfig {
  gameDir: string;
  modsCount: number;
  savesCount: number;
  lastCrashAt?: number | null;
}

export interface Account {
  id: string;
  type: 'microsoft' | 'offline';
  name: string;
  uuid: string;
  skinUrl?: string | null;
  /** 仅微软账号：令牌（仅存本机） */
  expiresAt?: number | null;
  lastUsedAt: number;
}

export type DownloadSource = 'auto' | 'bmclapi' | 'official' | 'custom';

export interface AppSettings {
  general: {
    zoomFactor: number;          // 界面缩放 1 = 100%
    autoBackupBeforeLaunch: boolean;
    backupKeep: number;
    confirmBeforeLaunch: boolean;
  };
  download: {
    source: DownloadSource;
    customMirror: string;        // 自定义镜像根地址
    maxThreads: number;          // 并发下载线程
    segmentSizeMB: number;       // 分段下载阈值
    timeoutMs: number;
    retries: number;
  };
  java: {
    /** 全局默认 Java 路径；空 = 按版本自动匹配 / 自动下载 */
    defaultPath: string;
  };
  launch: {
    autoKillResidual: boolean;   // 启动前清理残余游戏进程
    log4jFix: boolean;           // 1.17 以下自动附加 log4j 缓解参数
    utf8Encoding: boolean;       // 强制 UTF-8 文件编码
    showLogOnCrash: boolean;
  };
  curseforge: {
    apiKey: string;              // 可选：导入 CurseForge 整合包时用
  };
  migration: {
    copyInsteadOfMove: boolean;
  };
}

export interface VersionManifestEntry {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha';
  releaseTime: string;
  url: string;
  sha1: string;
}

export interface JavaInfo {
  path: string;
  version: string;
  major: number;
  vendor: string;
  is64: boolean;
  managed: boolean;              // 是否为 MCL 自动下载的
}

export interface DownloadProgress {
  taskId: string;
  name: string;
  bytesDone: number;
  bytesTotal: number;
  status: 'queued' | 'downloading' | 'verifying' | 'done' | 'failed' | 'canceled';
  error?: string;
}

export interface DownloadEvent {
  kind: 'progress' | 'taskDone' | 'overall' | 'failed';
  overall?: { done: number; total: number; tasksDone: number; tasksTotal: number };
  task?: DownloadProgress;
}

export interface CrashFix {
  id: string;
  label: string;
  description: string;
  /** 前端点击后回传给后端执行的动作名 */
  action:
    | 'fix:setMemoryPreset'
    | 'fix:switchJava'
    | 'fix:repairLibraries'
    | 'fix:reextractNatives'
    | 'fix:openModsFolder'
    | 'fix:toggleMirror'
    | 'fix:setUtf8'
    | 'fix:backupThenRestore'
    | 'fix:disableMod'
    | 'fix:addOpens';
  args?: Record<string, string>;
  severity: 'low' | 'medium' | 'high';
}

export interface CrashDiagnosis {
  matched: boolean;
  ruleId?: string;
  title: string;
  /** 人话解释 */
  summary: string;
  /** 给技术向用户的细节 */
  detail: string;
  fixes: CrashFix[];
  sourceFile: string;
  excerpt: string;
}

export interface BackupInfo {
  id: string;
  instanceId: string;
  name: string;
  filePath: string;
  sizeBytes: number;
  createdAt: number;
  kind: 'auto' | 'manual' | 'pre-restore' | 'world';
  worldNames: string[];
}

export interface ModSearchResult {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  author: string;
  downloads: number;
  follows: number;
  categories: string[];
  gameVersions: string[];
  loaders: string[];
}

export interface InstalledMod {
  fileName: string;
  projectId?: string | null;
  versionId?: string | null;
  versionNumber?: string | null;
  title?: string | null;
  loader?: string | null;
  installedAt: number;
  sizeBytes: number;
  disabled: boolean;
  updateAvailable?: { versionNumber: string; fileUrl: string; versionId: string } | null;
}

export interface ModHealthIssue {
  kind: 'duplicate' | 'zero-byte' | 'foreign-loader' | 'unknown-format' | 'outdated';
  modName: string;
  detail: string;
  fix?: { action: 'quarantine-newest' | 'quarantine-oldest' | 'quarantine-file' | 'none'; target?: string };
}

export interface MigrationCandidate {
  launcher: string;
  path: string;
  exists: boolean;
  hint: string;
}

export interface MigrationPreview {
  path: string;
  instances: Array<{
    name: string;
    mcVersion: string | null;
    loader?: LoaderType;
    loaderVersion?: string | null;
    saves: string[];
    modsCount: number;
    configFiles: number;
    totalBytes: number;
  }>;
}

export interface MigrationResult {
  imported: string[];
  skipped: Array<{ name: string; reason: string }>;
  /** 非致命但需要用户注意的事项（如实例未识别 MC 版本） */
  warnings?: string[];
}

export interface LaunchState {
  instanceId: string | null;
  status: 'idle' | 'preparing' | 'downloading' | 'launching' | 'running' | 'crashed' | 'exited';
  pid?: number | null;
  message?: string;
  progress?: { done: number; total: number } | null;
}

export interface EnvironmentReport {
  mclVersion: string;
  os: string;
  arch: string;
  totalMemoryGB: number;
  freeMemoryGB: number;
  dataDir: string;
  javas: JavaInfo[];
  instances: Array<{ name: string; mcVersion: string; loader: LoaderType }>;
  lastCrash?: CrashDiagnosis | null;
}
