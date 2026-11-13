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
  /** 本地披风贴图（仅离线账号，仅本机可见） */
  capeUrl?: string | null;
  /** 微软账号皮肤模型：classic（4 格手臂）/ slim（3 格手臂） */
  skinModel?: 'classic' | 'slim' | null;
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
    /** 未单独设置分辨率的实例使用的默认窗口尺寸 */
    defaultResolution: { width: number; height: number } | null;
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
    /** 全局附加 JVM 参数（实例参数之后追加） */
    globalJvmArgs: string;
  };
  curseforge: {
    apiKey: string;              // 可选：导入 CurseForge 整合包时用
  };
  migration: {
    copyInsteadOfMove: boolean;
  };
  cloud: CloudSettings;
}

/* ---------- 云同步 ---------- */
export type CloudProvider = 'off' | 'webdav' | 'gist';

export interface CloudSettings {
  provider: CloudProvider;
  /** WebDAV 目录 URL，如 https://dav.example.com/mcl/ */
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  /** GitHub PAT（只需 gist 权限） */
  gistToken: string;
  /** 已有 Gist ID；留空首次上传会自动创建 */
  gistId: string;
  /** 是否把存档一并同步（WebDAV 完整快照） */
  includeSaves: boolean;
  lastSyncAt?: number | null;
  lastSyncDirection?: 'upload' | 'download' | null;
}

export interface CloudSnapshotInfo {
  exists: boolean;
  updatedAt: number | null;
  sizeBytes: number | null;
  /** WebDAV 地址或 Gist ID */
  location: string;
  note: string;
}

/* ---------- 服务器 ---------- */
export type ServerLoader = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge';
export type ServerStatus = 'stopped' | 'preparing' | 'starting' | 'running' | 'stopping' | 'crashed';

export interface ServerConfig {
  id: string;
  name: string;
  mcVersion: string;
  loader: ServerLoader;
  loaderVersion?: string | null;
  port: number;
  memoryMB: number;
  javaPath?: string | null;
  jvmArgsExtra?: string;
  eulaAccepted: boolean;
  prepared: boolean;
  createdAt: number;
  lastStartedAt?: number | null;
}

export interface ServerInfo extends ServerConfig {
  dir: string;
  status: ServerStatus;
  pid?: number | null;
  startedAt?: number | null;
  players: string[];
  online: boolean;
  diskBytes: number;
  logTail: string[];
}

export interface ServerProperties {
  [key: string]: string;
}

export interface ServerBackupInfo {
  name: string;
  filePath: string;
  sizeBytes: number;
  createdAt: number;
}

/* ---------- 内容管理 ---------- */
export type ContentKind = 'resourcepacks' | 'shaderpacks' | 'screenshots' | 'worlds';

export interface ContentItem {
  name: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  mtime: number;
  enabled?: boolean;
  /** 世界图标 / 截图缩略图（通过 mcl-media:// 协议） */
  previewPath?: string | null;
}

export interface ContentList {
  resourcepacks: ContentItem[];
  shaderpacks: ContentItem[];
  screenshots: ContentItem[];
  worlds: ContentItem[];
}

/* ---------- 导出 ---------- */
export type ExportFormat = 'mmc' | 'mrpack' | 'zip';

export interface ExportResult {
  filePath: string;
  format: ExportFormat;
  sizeBytes: number;
  files: number;
  warnings?: string[];
}

/* ---------- 启动器更新 ---------- */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string | null;
  notes: string | null;
  publishedAt: string | null;
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
