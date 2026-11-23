/**
 * MCL 共享类型定义（主进程 / 渲染进程共用）
 */

export type LoaderType = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge';
export type MemoryPreset = 'low' | 'standard' | 'heavy';
export type AppChannel = 'stable' | 'dev';

/** 应用元信息：channel 由打包时写入的 channel.json 决定，源码直跑默认稳定版 */
export interface AppInfo {
  name: string;
  version: string;
  dataDir: string;
  platform: string;
  arch: string;
  channel: AppChannel;
}

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
  /** 自定义初始堆 / 最大堆（MB）：留空则按内存预设；两者同时填写且初始 ≤ 最大才生效（PCL CE 式） */
  heapInitialMB?: number | null;
  heapMaxMB?: number | null;
  /** 自定义 JVM 附加参数（空格分隔或每行一条） */
  jvmArgsExtra?: string;
  /** 该实例禁止自动更新 Mod（整合包玩家保护） */
  noModUpdate?: boolean;
  /** 自定义标签（用于实例页筛选，最多 8 个） */
  tags?: string[];
  /** 收藏：在首页/实例页置顶显示 */
  favorite?: boolean;
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

/** 启动器网络代理（仅支持 HTTP/HTTPS 代理，不支持 SOCKS5） */
export interface NetworkSettings {
  proxyMode: 'off' | 'manual';
  /** 例如 http://127.0.0.1:7890，也可以只填 127.0.0.1:7890 */
  proxyUrl: string;
  proxyUsername: string;
  proxyPassword: string;
  /** 下载游戏/模组/整合包时走代理 */
  applyToDownloads: boolean;
  /** 启动游戏/服务端时注入 JVM 代理参数 */
  applyToGame: boolean;
}

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
  network: NetworkSettings;
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
export interface UpdateAsset {
  name: string;
  url: string;
  sizeBytes: number | null;
}

export interface UpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string | null;
  notes: string | null;
  publishedAt: string | null;
  /** Release 附件（安装包 / 便携 ZIP），用于应用内下载 */
  assets: UpdateAsset[];
}

/* ---------- 局域网世界 ---------- */
export interface LanWorld {
  motd: string;
  address: string;
  port: number;
  /** 是否为本机开放的局域网世界 */
  local: boolean;
}

/* ---------- Modrinth 内容下载 ---------- */
export type ContentProjectType = 'mod' | 'modpack' | 'resourcepack' | 'shader' | 'datapack' | 'world';

export interface ContentInstallResult {
  fileName: string;
  path: string;
  sizeBytes: number;
  /** 世界：解压后的世界文件夹名 */
  worldName?: string;
  /** 整合包：导入后创建的新实例 ID */
  instanceId?: string;
  /** 整合包：导入过程中的提示（如 CurseForge 需手动下载） */
  warnings?: string[];
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

/* ---------- 下载任务中心 ---------- */
export type TaskKind = 'launch' | 'mod' | 'resourcepack' | 'shader' | 'world' | 'modpack' | 'java' | 'update' | 'server' | 'other';
export type TaskStatus = 'running' | 'done' | 'failed' | 'canceled';

/** 任务完成后可执行的后续动作（用于「重试」与「打开目录」），全部指向本机路径/既有能力 */
export interface TaskAction {
  /** 重新执行对应的已有 IPC 能力 */
  retry?: { type: 'update' } | { type: 'java'; major: number } | { type: 'modpack'; filePath: string } | { type: 'launch'; instanceId: string };
  /** 在数据目录内、可直接用 openPath 打开的文件夹 */
  openDir?: string;
  /** 数据目录外的文件，用 appRevealFile 在资源管理器中定位 */
  revealFile?: string;
}

export interface DownloadTaskInfo {
  id: string;
  name: string;
  kind: TaskKind;
  status: TaskStatus;
  bytesDone: number;
  bytesTotal: number;
  /** 瞬时速度（字节/秒），由主进程按相邻两次进度估算 */
  speed: number;
  /** 是否有可调用的取消回调（仅进行中的任务有意义，重启后失效） */
  cancelable?: boolean;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  action?: TaskAction;
}

/* ---------- 游戏设置可视化 ---------- */
/** options.txt 里允许界面编辑的键（主进程有白名单，这里只用于类型提示） */
export type GameOptions = Record<string, string>;

/* ---------- 游玩统计 ---------- */
export interface PlayStats {
  /** 最近 7 天（含今天）的游玩秒数，按日期升序 */
  daily: Array<{ date: string; seconds: number }>;
  totalSeconds: number;
  sessions: number;
  /** 按实例累计的游玩秒数（降序，已附上实例名） */
  perInstance: Array<{ instanceId: string; name: string; seconds: number }>;
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
  /** 最近一次是正常退出（退出码 0），不是崩溃；界面上不应显示「未知崩溃」 */
  normal?: boolean;
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
