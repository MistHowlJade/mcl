/**
 * MCL 数据目录布局
 *
 * 便携模式：exe 同级目录存在 portable.txt → 数据放 <exeDir>/mcl-data
 * 开发模式：项目根目录/.mcl-data
 * 默认：   %APPDATA%/mcl
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

export function dataRoot(): string {
  if (cachedRoot) return cachedRoot;
  const override = process.env.MCL_HOME;
  if (override) {
    cachedRoot = override;
    return cachedRoot;
  }
  if (app.isPackaged) {
    const exeDir = path.dirname(process.execPath);
    if (fs.existsSync(path.join(exeDir, 'portable.txt'))) {
      cachedRoot = path.join(exeDir, 'mcl-data');
      return cachedRoot;
    }
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
    backupsDir(), logsDir(),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 游戏实例内部的标准子目录 */
export const GAME_SUBDIRS = [
  'saves', 'mods', 'config', 'resourcepacks', 'shaderpacks',
  'screenshots', 'logs', 'crash-reports', 'data',
] as const;
