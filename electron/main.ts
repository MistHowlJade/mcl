/**
 * MCL 主进程入口
 * - 无边框窗口 + 深色原生底
 * - 启动时静默清理残余游戏进程（痛点 #31）
 * - 安全默认值：contextIsolation + sandbox + 无 nodeIntegration
 */
import { app, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import { registerIpcHandlers, bindServiceEvents } from './services/ipc';
import { ensureLayout } from './services/paths';
import { getSettings } from './services/settings';
import { killResidualProcesses } from './services/minecraft';

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

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
