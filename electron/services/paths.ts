/**
 * MCL 数据目录布局（PCL2 / HMCL 式：数据默认跟着启动器走）
 *
 * 打包态默认：<启动器目录>/mcl-data（免安装 ZIP 解压后可写，拷走整个文件夹即带走全部游戏资源）
 * 兼容：exe 同级仍有 portable.txt 时同样使用 <该目录>/mcl-data
 * 回退：若启动器目录不可写（如装在 Program Files），退回 %APPDATA%/mcl
 * 开发模式：项目根目录/.mcl-data
 * 环境变量 MCL_HOME 优先级最高（用于隔离测试）
 *
 * 布局：
 *   <root>/shared/assets/objects/<hash2>/<hash>
 *   <root>/shared/libraries/<maven path>          ← 全实例共享，根治多实例磁盘膨胀（痛点 #48）
 *   <root>/shared/versions/<id>/<id>.json|jar     ← 全实例共享
 *   <root>/instances/<id>/game/                   ← 每个实例独立的 .minecraft（版本隔离，痛点 #43）
 *   <root>/instances/<id>/instance.json
 *   <root>/java/<major>/                          ← MCL 自动下载的 JRE
 *   <root>/cache/                                 ← 下载临时文件（.part）
 *   <root>/backups/<instanceId>/<name>.zip
 *   <root>/logs/mcl.log
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

let cachedRoot: string | null = null;

/** 能否在该目录创建数据目录（用于决定是否真的可以“跟着本体走”） */
function canWriteDataDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.mcl-write-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** 启动器所在目录；macOS 的可执行体在 Electron.app 内部，数据放 .app 旁边 */
function launcherDir(): string {
  const exeDir = path.dirname(process.execPath);
  return process.platform === 'darwin' ? path.resolve(exeDir, '..', '..', '..') : exeDir;
}

export function dataRoot(): string {
  if (cachedRoot) return cachedRoot;
  const override = process.env.MCL_HOME;
  if (override) {
    cachedRoot = override;
    return cachedRoot;
  }
  if (app.isPackaged) {
    const exeDir = path.dirname(process.execPath);
    const appDir = launcherDir();
    // 兼容旧的 portable.txt 约定：有标记时以标记所在目录为准
    const portableDirs = appDir === exeDir ? [exeDir] : [exeDir, appDir];
    const portableDir = portableDirs.find(d => fs.existsSync(path.join(d, 'portable.txt')));
    if (portableDir) {
      const root = path.join(portableDir, 'mcl-data');
      if (canWriteDataDir(root)) {
        cachedRoot = root;
        return cachedRoot;
      }
    }
    // PCL2 / HMCL 式：默认就在启动器旁边建 mcl-data，所有游戏资源跟着本体走
    const beside = path.join(appDir, 'mcl-data');
    if (canWriteDataDir(beside)) {
      cachedRoot = beside;
      return cachedRoot;
    }
    // 启动器装在只读目录（如 Program Files）才退回用户目录
    cachedRoot = app.getPath('userData');
    return cachedRoot;
  }
  // 开发环境：放在仓库根目录下，便于排查
  cachedRoot = path.resolve(process.cwd(), '.mcl-data');
  return cachedRoot;
}

export function sharedDir(): string { return path.join(dataRoot(), 'shared'); }
export function assetsDir(): string { return path.join(sharedDir(), 'assets'); }
export function assetsObjectsDir(): string { return path.join(assetsDir(), 'objects'); }
export function assetsIndexDir(): string { return path.join(assetsDir(), 'indexes'); }
export function librariesDir(): string { return path.join(sharedDir(), 'libraries'); }
export function versionsDir(): string { return path.join(sharedDir(), 'versions'); }
export function instancesDir(): string { return path.join(dataRoot(), 'instances'); }
export function instanceDir(id: string): string { return path.join(instancesDir(), id); }
export function gameDir(id: string): string { return path.join(instanceDir(id), 'game'); }
export function nativesRoot(id: string): string { return path.join(instanceDir(id), 'natives'); }
export function javaDir(): string { return path.join(dataRoot(), 'java'); }
export function cacheDir(): string { return path.join(dataRoot(), 'cache'); }
export function backupsDir(): string { return path.join(dataRoot(), 'backups'); }
export function instanceBackupsDir(id: string): string { return path.join(backupsDir(), id); }
export function logsDir(): string { return path.join(dataRoot(), 'logs'); }
export function serversDir(): string { return path.join(dataRoot(), 'servers'); }
export function serverDir(id: string): string { return path.join(serversDir(), id); }
export function serverFile(id: string): string { return path.join(serverDir(id), 'server.json'); }
export function serverBackupsDir(id: string): string { return path.join(serverDir(id), 'backups'); }
export function configFile(): string { return path.join(dataRoot(), 'config.json'); }
export function accountsFile(): string { return path.join(dataRoot(), 'accounts.json'); }
export function instancesIndexFile(): string { return path.join(dataRoot(), 'instances.json'); }
export function residualPidsFile(): string { return path.join(dataRoot(), 'residual-pids.json'); }
export function installedModsFile(id: string): string { return path.join(instanceDir(id), 'installed-mods.json'); }
export function instanceFile(id: string): string { return path.join(instanceDir(id), 'instance.json'); }

export function ensureLayout(): void {
  for (const dir of [
    dataRoot(), sharedDir(), assetsDir(), assetsObjectsDir(), assetsIndexDir(),
    librariesDir(), versionsDir(), instancesDir(), javaDir(), cacheDir(),
    backupsDir(), logsDir(), serversDir(),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 游戏实例内部的标准子目录 */
export const GAME_SUBDIRS = [
  'saves', 'mods', 'config', 'resourcepacks', 'shaderpacks',
  'screenshots', 'logs', 'crash-reports', 'data',
] as const;
