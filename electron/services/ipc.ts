/**
 * IPC 总线：渲染进程 ↔ 主进程
 * 所有 handle 包装统一错误边界（异常 → 标准 { ok:false, error } 之外的抛出由 renderer catch）
 */
import { BrowserWindow, dialog, ipcMain, shell, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as paths from './paths';
import { getSettings, updateSettings, resetSettings } from './settings';
import * as instances from './instances';
import * as versionService from './version';
import * as javaService from './java';
import * as authService from './auth';
import * as minecraft from './minecraft';
import * as backups from './backup';
import * as modrinth from './modrinth';
import * as modpack from './modpack';
import * as modhealth from './modhealth';
import * as migrate from './migrate';
import * as crashService from './crash';
import * as diagnostic from './diagnostic';
import * as logsService from './logs';
import * as serverService from './server';
import * as cloudService from './cloud';
import * as contentService from './content';
import * as exporter from './exporter';
import * as updateService from './update';
import { getVersionManifest } from './version';
import { CrashFix, LoaderType, MemoryPreset } from '../shared/types';

const sendToAll = (channel: string, payload: unknown) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
};

// 服务事件 → 渲染进程
export function bindServiceEvents(): void {
  minecraft.launchEvents.on('status', s => sendToAll('launch:status', s));
  minecraft.launchEvents.on('log', line => sendToAll('launch:log', line));
  minecraft.launchEvents.on('progress', p => sendToAll('launch:progress', p));
  minecraft.launchEvents.on('crash', d => sendToAll('launch:crash', d));
  minecraft.launchEvents.on('exit', e => sendToAll('launch:exit', e));
  serverService.serverEvents.on('status', (info: unknown) => sendToAll('server:status', info));
  serverService.serverEvents.on('log', (payload: unknown) => sendToAll('server:log', payload));
}

const isSafeExternal = (url: string) => /^https?:\/\//i.test(url);

export function registerIpcHandlers(): void {
  /* ---------- 应用元信息 ---------- */
  ipcMain.handle('app:info', () => ({
    name: 'MCL',
    version: app.getVersion(),
    dataDir: paths.dataRoot(),
    platform: process.platform,
    arch: process.arch,
  }));

  /* ---------- 窗口控制（无边框窗口） ---------- */
  ipcMain.handle('win:minimize', () => BrowserWindow.getFocusedWindow()?.minimize());
  ipcMain.handle('win:toggleMaximize', () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:isMaximized', () => BrowserWindow.getFocusedWindow()?.isMaximized() ?? false);
  ipcMain.handle('win:close', () => BrowserWindow.getFocusedWindow()?.close());
  ipcMain.handle('win:setZoom', (_e, factor: number) => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.webContents.setZoomFactor(Math.min(2, Math.max(0.75, Number(factor) || 1)));
    return true;
  });

  /* ---------- 设置 ---------- */
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:update', (_e, patch: any) => updateSettings(patch));
  ipcMain.handle('settings:reset', () => resetSettings());

  /* ---------- Shell ---------- */
  ipcMain.handle('shell:openPath', (_e, p: string) => {
    if (typeof p !== 'string' || !p) return '路径无效';
    return shell.openPath(p);
  });
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (!isSafeExternal(url)) return;
    return shell.openExternal(url);
  });
  ipcMain.handle('dialog:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: '选择数据目录' });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('dialog:pickFile', async (_e, filters: Array<{ name: string; extensions: string[] }>) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters });
    return result.canceled ? null : result.filePaths[0];
  });

  /* ---------- 版本清单 ---------- */
  ipcMain.handle('versions:list', async () => {
    const settings = getSettings();
    const manifest = await getVersionManifest(settings.download.source, settings.download.customMirror);
    return manifest.versions.map(v => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
  });

  /* ---------- Java ---------- */
  ipcMain.handle('java:detect', () => javaService.detectSystemJavas());
  ipcMain.handle('java:recommended', (_e, mcVersion: string) => ({
    major: javaService.recommendedJavaMajor(mcVersion),
  }));
  ipcMain.handle('java:install', async (_e, major: number) => {
    const exe = await javaService.installJava(major, (stage, received, total) => sendToAll('java:progress', { stage, received, total }));
    return exe;
  });

  /* ---------- 实例 ---------- */
  ipcMain.handle('instances:list', () => instances.listInstances());
  ipcMain.handle('instances:get', (_e, id: string) => instances.getInstance(id));
  ipcMain.handle('instances:create', (_e, input: { name: string; mcVersion: string; loader: LoaderType; loaderVersion?: string | null; memoryPreset?: MemoryPreset; javaPath?: string | null }) => instances.createInstance(input));
  ipcMain.handle('instances:update', (_e, id: string, patch: any) => instances.updateInstance(id, patch));
  ipcMain.handle('instances:delete', async (_e, id: string) => {
    const backupDir = path.join(paths.backupsDir(), 'deleted-instances');
    return instances.deleteInstance(id, backupDir);
  });
  ipcMain.handle('instances:diskUsage', (_e, id: string) => ({ instance: instances.instanceDiskBytes(id), shared: instances.sharedDiskBytes() }));
  ipcMain.handle('instances:openGameDir', (_e, id: string) => shell.openPath(paths.gameDir(id)));
  ipcMain.handle('instances:openInstanceDir', (_e, id: string) => shell.openPath(paths.instanceDir(id)));

  /* ---------- 启动 ---------- */
  ipcMain.handle('launch:start', async (_e, instanceId: string, accountId?: string | null) => {
    minecraft.launchState.instanceId = instanceId;
    // 状态由 launchInstance 自己推进（它的并发保护依赖 status，不能在这里预写）
    void minecraft.launchInstance(instanceId, { accountId }).catch(err => {
      const message = err instanceof Error ? err.message : String(err);
      minecraft.launchState.status = 'idle';
      minecraft.launchState.message = message;
      minecraft.launchState.progress = null;
      sendToAll('launch:status', { ...minecraft.launchState });
      sendToAll('launch:failed', { instanceId, error: message });
    });
    return { started: true };
  });
  ipcMain.handle('launch:state', () => ({ ...minecraft.launchState }));
  ipcMain.handle('launch:killResidual', async () => ({ killed: await minecraft.killResidualProcesses() }));

  /* ---------- 账号 ---------- */
  ipcMain.handle('accounts:list', () => authService.listAccounts());
  ipcMain.handle('accounts:active', () => authService.getActiveAccount());
  ipcMain.handle('accounts:setActive', (_e, id: string) => { authService.setActiveAccount(id); return true; });
  ipcMain.handle('accounts:remove', (_e, id: string) => { authService.removeAccount(id); return true; });
  ipcMain.handle('accounts:createOffline', (_e, name: string, skinDataUrl?: string | null) => authService.createOfflineAccount(name, skinDataUrl ?? null));
  ipcMain.handle('accounts:beginMicrosoft', async () => {
    const session = await authService.beginMicrosoftLogin();
    // 后台完成轮询链路；结果通过事件推给渲染进程
    void authService.finishMicrosoftLogin(session).then(result => {
      sendToAll('accounts:microsoft-result', { ok: true, account: result.account, warn: result.warn ?? null });
    }).catch(err => {
      sendToAll('accounts:microsoft-result', { ok: false, error: err instanceof Error ? err.message : String(err) });
    });
    return session;
  });
  /* ---------- 皮肤 / 披风 ---------- */
  const pickPng = async (title: string): Promise<string | null> => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      title,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };

  ipcMain.handle('accounts:localSkin', async (_e, accountId: string, model: 'classic' | 'slim') => {
    const file = await pickPng('选择皮肤 PNG（64×64 或旧版 64×32）');
    if (!file) return null;
    return authService.setLocalSkin(accountId, file, model === 'slim' ? 'slim' : 'classic');
  });
  ipcMain.handle('accounts:clearLocalSkin', (_e, accountId: string) => authService.clearLocalSkin(accountId));
  ipcMain.handle('accounts:localCape', async (_e, accountId: string) => {
    const file = await pickPng('选择披风 PNG（64×32）');
    if (!file) return null;
    return authService.setLocalCape(accountId, file);
  });
  ipcMain.handle('accounts:clearLocalCape', (_e, accountId: string) => authService.clearLocalCape(accountId));
  ipcMain.handle('accounts:microsoftSkin', async (_e, accountId: string, variant: 'classic' | 'slim') => {
    const file = await pickPng('选择要上传到 Mojang 的皮肤 PNG');
    if (!file) return null;
    return authService.uploadMicrosoftSkin(accountId, file, variant === 'slim' ? 'slim' : 'classic');
  });
  ipcMain.handle('accounts:microsoftSkinReset', (_e, accountId: string) => authService.resetMicrosoftSkin(accountId));

  /* ---------- 模组（Modrinth） ---------- */
  ipcMain.handle('modrinth:search', (_e, query: string, opts: { loader?: string; gameVersion?: string; projectType?: 'mod' | 'modpack'; index?: 'relevance' | 'downloads' | 'follows' | 'updated' }) =>
    modrinth.searchMods(query, opts));
  ipcMain.handle('modrinth:installed', (_e, instanceId: string) => {
    const tracked = modrinth.readInstalledMods(instanceId);
    const files = modrinth.listModFiles(instanceId);
    return files.map(f => {
      const match = tracked.find(t => t.fileName === f.fileName);
      return match ? { ...match, sizeBytes: f.sizeBytes, disabled: f.disabled } : {
        fileName: f.fileName, projectId: null, versionId: null, versionNumber: null, title: null, loader: null,
        installedAt: 0, sizeBytes: f.sizeBytes, disabled: f.disabled, updateAvailable: null,
      };
    });
  });
  ipcMain.handle('modrinth:install', (_e, instanceId: string, projectId: string, versionId: string | null, opts: { loader?: string; gameVersion?: string }) =>
    modrinth.installMod(instanceId, projectId, versionId ?? undefined, opts));
  ipcMain.handle('modrinth:checkUpdates', (_e, instanceId: string, mcVersion: string, loader?: string) =>
    modrinth.checkModUpdates(instanceId, mcVersion, loader));
  ipcMain.handle('modrinth:updateMod', (_e, instanceId: string, fileName: string) => modrinth.updateMod(instanceId, fileName));
  ipcMain.handle('modrinth:toggle', (_e, instanceId: string, fileName: string) => modrinth.toggleModDisabled(instanceId, fileName));

  /* ---------- 模组体检 ---------- */
  ipcMain.handle('mods:health', (_e, instanceId: string) => {
    const instance = instances.getInstance(instanceId);
    if (!instance) throw new Error('实例不存在');
    return modhealth.checkModHealth(instanceId, instance.gameDir, instance.loader);
  });
  ipcMain.handle('mods:healthFix', (_e, instanceId: string, target: string) => {
    const instance = instances.getInstance(instanceId);
    if (!instance) throw new Error('实例不存在');
    return modhealth.applyModHealthFix(instanceId, instance.gameDir, target);
  });
  ipcMain.handle('mods:openFolder', (_e, instanceId: string) => {
    const instance = instances.getInstance(instanceId);
    if (!instance) throw new Error('实例不存在');
    return shell.openPath(path.join(instance.gameDir, 'mods'));
  });

  /* ---------- 整合包导入 ---------- */
  ipcMain.handle('modpack:importDialog', async (_e, targetName?: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      title: '选择整合包（.zip）',
      filters: [{ name: '整合包', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return modpack.importModpack(result.filePaths[0], targetName, line => sendToAll('modpack:log', line));
  });
  ipcMain.handle('modpack:importFile', (_e, filePath: string, targetName?: string) =>
    modpack.importModpack(filePath, targetName, line => sendToAll('modpack:log', line)));

  /* ---------- 备份 ---------- */
  ipcMain.handle('backup:list', (_e, instanceId: string) => backups.listBackups(instanceId));
  ipcMain.handle('backup:create', (_e, instanceId: string, name?: string) => backups.createBackup(instanceId, 'manual', name));
  ipcMain.handle('backup:delete', (_e, backupId: string) => { backups.deleteBackup(backupId); return true; });
  ipcMain.handle('backup:restore', (_e, backupId: string, instanceId: string) => backups.restoreBackup(backupId, instanceId));

  /* ---------- 崩溃分析 ---------- */
  ipcMain.handle('crash:latest', (_e, instanceId: string) => crashService.analyzeCrash(instanceId));
  ipcMain.handle('crash:analyzeText', (_e, text: string) => crashService.analyzeLogText(text));
  ipcMain.handle('crash:fix', async (_e, instanceId: string, fix: CrashFix) => {
    switch (fix.action) {
      case 'fix:setMemoryPreset': {
        const preset = (fix.args?.preset ?? 'heavy') as MemoryPreset;
        instances.updateInstance(instanceId, { memoryPreset: preset });
        return { ok: true, message: `已切换到「${preset === 'heavy' ? '大型整合包/光影' : preset}」内存预设，下次启动生效。` };
      }
      case 'fix:switchJava': {
        const instance = instances.getInstance(instanceId);
        if (!instance) throw new Error('实例不存在');
        const major = javaService.recommendedJavaMajor(instance.mcVersion);
        const pick = await javaService.pickJavaFor(instance.mcVersion, null);
        if (pick.java) {
          instances.updateInstance(instanceId, { javaPath: pick.java.path });
          return { ok: true, message: `已绑定 Java ${pick.java.version}（${pick.java.path}）。` };
        }
        const exe = await javaService.installJava(major, (stage, received, total) => sendToAll('java:progress', { stage, received, total }));
        instances.updateInstance(instanceId, { javaPath: exe });
        return { ok: true, message: `已自动下载并绑定 Java ${major}。` };
      }
      case 'fix:repairLibraries': {
        const result = await minecraft.repairLibraries(instanceId);
        return { ok: true, message: `已检查 ${result.checked} 个文件，修复 ${result.repaired} 个损坏文件${result.failed ? `，${result.failed} 个修复失败` : ''}。` };
      }
      case 'fix:reextractNatives': {
        minecraft.reextractNatives(instanceId);
        return { ok: true, message: '已清理旧的 natives 残留，下次启动将重新提取。' };
      }
      case 'fix:openModsFolder': {
        const instance = instances.getInstance(instanceId);
        if (instance) shell.openPath(path.join(instance.gameDir, 'mods'));
        return { ok: true, message: '已打开 mods 文件夹。' };
      }
      case 'fix:toggleMirror': {
        const settings = getSettings();
        const next = settings.download.source === 'official' ? 'auto' : 'official';
        updateSettings({ download: { ...settings.download, source: next } });
        return { ok: true, message: `下载源已切换为：${next === 'auto' ? '自动（BMCLAPI + 官方兜底）' : '官方源'}。` };
      }
      case 'fix:setUtf8': {
        updateSettings({ launch: { utf8Encoding: true } });
        return { ok: true, message: '已开启强制 UTF-8 编码。' };
      }
      case 'fix:backupThenRestore': {
        const info = await backups.createBackup(instanceId, 'pre-restore', '一键修复前自动备份');
        return { ok: true, message: info ? `已创建备份：${info.name}（${Math.round(info.sizeBytes / 1024 / 1024)} MB）。` : '没有找到存档，已跳过备份。' };
      }
      case 'fix:addOpens': {
        const instance = instances.getInstance(instanceId);
        if (!instance) throw new Error('实例不存在');
        const required = '--add-opens java.base/java.lang=ALL-UNNAMED';
        const current = (instance.jvmArgsExtra ?? '').split(/\s+/).filter(Boolean).join(' ');
        if (!current.includes(required)) {
          instances.updateInstance(instanceId, { jvmArgsExtra: `${current} ${required}`.trim() });
        }
        return { ok: true, message: '已添加模块开放参数，下次启动生效。' };
      }
      case 'fix:disableMod': {
        const instance = instances.getInstance(instanceId);
        if (!instance) throw new Error('实例不存在');
        const modsDir = path.join(instance.gameDir, 'mods');
        const target = fix.args?.file;
        if (target) {
          const enabled = path.join(modsDir, path.basename(target));
          if (fs.existsSync(enabled)) {
            const disabled = enabled + '.disabled';
            fs.renameSync(enabled, disabled);
            return { ok: true, message: `已将 ${path.basename(target)} 重命名为 .disabled，下次启动生效。` };
          }
          if (fs.existsSync(enabled + '.disabled')) {
            return { ok: true, message: `${path.basename(target)} 已经是 .disabled。` };
          }
          return { ok: false, message: `在 mods 中找不到 ${target}` };
        }
        // 未指定具体模组：列出当前 mods 目录里全部条目，引导到体检处理
        const files = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter(f => f.endsWith('.jar') || f.endsWith('.disabled')) : [];
        return {
          ok: true,
          message: files.length > 0
            ? `mods 目录当前 ${files.length} 个文件：${files.slice(0, 8).join('、')}${files.length > 8 ? '…' : ''}。请用「模组 → 体检」定位问题模组，或告诉 MCL 具体是哪个文件并传参 fix:disableMod + file=<文件名>。`
            : 'mods 目录为空。',
        };
      }
      default:
        return { ok: false, message: '未知的修复动作。' };
    }
  });

  /* ---------- 迁移 ---------- */
  ipcMain.handle('migrate:detect', () => migrate.detectCandidates());
  ipcMain.handle('migrate:preview', (_e, root: string) => migrate.previewMigration(root));
  ipcMain.handle('migrate:import', (_e, root: string, selectedNames?: string[]) => migrate.importInstances(root, selectedNames));

  /* ---------- 日志 ---------- */
  ipcMain.handle('logs:list', (_e, instanceId?: string | null) => logsService.listLogs(instanceId));
  ipcMain.handle('logs:read', (_e, name: string, instanceId?: string | null) => logsService.readLog(name, instanceId));

  /* ---------- 诊断包 ---------- */
  ipcMain.handle('diagnostic:export', (_e, instanceId?: string | null) => diagnostic.exportDiagnostic(instanceId ?? null));

  /* ---------- 服务器管理 ---------- */
  ipcMain.handle('server:list', () => serverService.listServers());
  ipcMain.handle('server:get', (_e, id: string) => serverService.getServer(id));
  ipcMain.handle('server:create', (_e, input: any) => serverService.createServer(input));
  ipcMain.handle('server:update', (_e, id: string, patch: any) => serverService.updateServer(id, patch));
  ipcMain.handle('server:delete', (_e, id: string, backup?: boolean) => serverService.deleteServer(id, backup !== false));
  ipcMain.handle('server:prepare', (_e, id: string) => serverService.prepareServer(id));
  ipcMain.handle('server:start', (_e, id: string) => serverService.startServer(id));
  ipcMain.handle('server:stop', (_e, id: string) => serverService.stopServer(id));
  ipcMain.handle('server:kill', (_e, id: string) => serverService.killServer(id));
  ipcMain.handle('server:sendCommand', (_e, id: string, command: string) => serverService.sendCommand(id, command));
  ipcMain.handle('server:checkPort', (_e, port: number) => serverService.isPortAvailable(port));
  ipcMain.handle('server:acceptEula', (_e, id: string) => serverService.acceptEula(id));
  ipcMain.handle('server:properties', (_e, id: string) => serverService.readServerProperties(id));
  ipcMain.handle('server:saveProperties', (_e, id: string, patch: Record<string, string>) => serverService.saveServerProperties(id, patch));
  ipcMain.handle('server:log', (_e, id: string, maxLines?: number) => serverService.readServerLog(id, maxLines ?? 400));
  ipcMain.handle('server:openDir', (_e, id: string) => shell.openPath(paths.serverDir(id)));
  ipcMain.handle('server:backups', (_e, id: string) => serverService.listServerBackups(id));
  ipcMain.handle('server:backup', (_e, id: string, name?: string) => serverService.backupServerWorld(id, name));
  ipcMain.handle('server:restoreBackup', (_e, id: string, name: string) => serverService.restoreServerWorld(id, name));
  ipcMain.handle('server:deleteBackup', (_e, id: string, name: string) => { serverService.deleteServerBackup(id, name); return true; });

  /* ---------- 云同步 ---------- */
  ipcMain.handle('cloud:test', () => cloudService.testCloud());
  ipcMain.handle('cloud:inspect', () => cloudService.inspectCloud());
  ipcMain.handle('cloud:upload', () => cloudService.uploadCloud());
  ipcMain.handle('cloud:download', () => cloudService.downloadCloud());

  /* ---------- 内容管理 ---------- */
  ipcMain.handle('content:list', (_e, instanceId: string) => contentService.listContent(instanceId));
  ipcMain.handle('content:toggleResourcePack', (_e, instanceId: string, fileName: string) => contentService.toggleResourcePack(instanceId, fileName));
  ipcMain.handle('content:toggleShaderPack', (_e, instanceId: string, fileName: string) => contentService.toggleShaderPack(instanceId, fileName));
  ipcMain.handle('content:delete', (_e, instanceId: string, kind: any, fileName: string) => contentService.deleteContent(instanceId, kind, fileName));
  ipcMain.handle('content:backupWorld', (_e, instanceId: string, worldName: string, displayName?: string) => contentService.backupWorld(instanceId, worldName, displayName));
  ipcMain.handle('content:openItem', (_e, p: string) => {
    const root = path.resolve(paths.dataRoot());
    const target = path.resolve(p);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('只能打开 MCL 数据目录内的文件');
    return shell.openPath(target);
  });
  ipcMain.handle('content:openFolder', (_e, instanceId: string, kind: any) => {
    const instance = instances.getInstance(instanceId);
    if (!instance) throw new Error('实例不存在');
    const dirs: Record<string, string> = {
      resourcepacks: 'resourcepacks',
      shaderpacks: 'shaderpacks',
      screenshots: 'screenshots',
      worlds: 'saves',
    };
    const sub = dirs[String(kind)];
    if (!sub) throw new Error('未知的内容类型');
    return shell.openPath(path.join(instance.gameDir, sub));
  });
  ipcMain.handle('content:importDialog', async (_e, instanceId: string, kind: any, mode?: 'file' | 'folder') => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) throw new Error('窗口不可用');
    const isWorld = kind === 'worlds';
    const wantFolder = isWorld || mode === 'folder';
    if (wantFolder) {
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'multiSelections'],
        title: isWorld ? '选择要导入的世界文件夹' : '选择要导入的文件夹',
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      return contentService.importContent(instanceId, kind, result.filePaths);
    }
    const filters = kind === 'screenshots'
      ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }]
      : [{ name: kind === 'shaderpacks' ? '光影包 ZIP' : '资源包 ZIP', extensions: ['zip'] }];
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: kind === 'screenshots' ? '选择要导入的截图' : '选择要导入的 ZIP',
      filters,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return contentService.importContent(instanceId, kind, result.filePaths);
  });

  /* ---------- 实例导出 ---------- */
  ipcMain.handle('export:instance', async (_e, instanceId: string, format: any) => {
    const instance = instances.getInstance(instanceId);
    if (!instance) throw new Error('实例不存在');
    if (!['mmc', 'mrpack', 'zip'].includes(String(format))) throw new Error('未知的导出格式');
    const defaultName = exporter.defaultExportName(instance, format);
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showSaveDialog(win!, {
      title: '导出实例',
      defaultPath: path.join(app.getPath('downloads'), defaultName),
      filters: [{
        name: format === 'mrpack' ? 'Modrinth 整合包' : 'ZIP 压缩包',
        extensions: [format === 'mrpack' ? 'mrpack' : 'zip'],
      }],
    });
    if (result.canceled || !result.filePath) return null;
    return exporter.exportInstance(instanceId, format, result.filePath);
  });

  /* ---------- 启动器更新 ---------- */
  ipcMain.handle('app:updateCheck', () => updateService.checkUpdate());

  /* ---------- 缓存清理 ---------- */
  const measureDir = (dir: string): { sizeBytes: number; files: number } => {
    let sizeBytes = 0;
    let files = 0;
    const walk = (d: string) => {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else { try { sizeBytes += fs.statSync(full).size; files++; } catch { /* ignore */ } }
      }
    };
    walk(dir);
    return { sizeBytes, files };
  };
  ipcMain.handle('app:cacheInfo', () => ({ dir: paths.cacheDir(), ...measureDir(paths.cacheDir()) }));
  ipcMain.handle('app:clearCache', () => {
    const dir = paths.cacheDir();
    const before = measureDir(dir);
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      }
    }
    return { freedBytes: before.sizeBytes, removedFiles: before.files };
  });

  /* ---------- 下载源测速 ---------- */
  ipcMain.handle('mirror:test', async () => {
    const { pickBestSource } = await import('./net');
    return pickBestSource(getSettings().download.customMirror);
  });
}
