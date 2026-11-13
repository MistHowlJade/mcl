/**
 * MCL 主进程入口
 * - 无边框窗口 + 深色原生底
 * - 启动时静默清理残余游戏进程（痛点 #31）
 * - 安全默认值：contextIsolation + sandbox + 无 nodeIntegration
 */
import { app, BrowserWindow, shell, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerIpcHandlers, bindServiceEvents } from './services/ipc';
import { dataRoot, ensureLayout } from './services/paths';
import { getSettings } from './services/settings';
import { killResidualProcesses } from './services/minecraft';
import { killAllServersSync } from './services/server';

// 本地媒体协议：只读、限定在 MCL 数据目录内，用于截图/世界图标预览
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'mcl-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function registerMediaProtocol(): void {
  protocol.handle('mcl-media', async (request) => {
    try {
      const url = new URL(request.url);
      const raw = url.searchParams.get('p');
      if (!raw) return new Response('缺少路径参数', { status: 400 });
      const target = path.resolve(decodeURIComponent(raw));
      const root = path.resolve(dataRoot());
      // 目录穿越防护：渲染进程只能读取 MCL 数据目录内的文件
      if (target !== root && !target.startsWith(root + path.sep)) {
        return new Response('拒绝访问数据目录之外的文件', { status: 403 });
      }
      const stat = await fs.promises.stat(target);
      if (!stat.isFile()) return new Response('文件不存在', { status: 404 });
      const data = await fs.promises.readFile(target);
      return new Response(data, {
        headers: {
          'Content-Type': MEDIA_MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
      });
    } catch {
      return new Response('文件不存在', { status: 404 });
    }
  });
}

// 单实例锁：防止同时开两个窗口导致数据目录竞争
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

async function createWindow(): Promise<void> {
  ensureLayout();
  const settings = getSettings();
  const win = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    backgroundColor: '#10131a',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    win.webContents.setZoomFactor(Math.min(2, Math.max(0.75, settings.general.zoomFactor || 1)));
  });

  // 外部链接一律交给系统浏览器，不在应用内打开（防钓鱼）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    await win.loadURL(DEV_URL);
  } else {
    await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  registerMediaProtocol();
  registerIpcHandlers();
  bindServiceEvents();
  // 残余进程清理：异步进行，不阻塞窗口
  const settings = getSettings();
  if (settings.launch.autoKillResidual) {
    void killResidualProcesses().catch(() => undefined);
  }
  void createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

// 启动器退出时结束所有由 MCL 启动的服务端，避免留下孤儿 Java 进程
app.on('before-quit', () => {
  try { killAllServersSync(); } catch { /* 忽略 */ }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
