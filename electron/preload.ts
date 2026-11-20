/**
 * Preload：唯一的渲染进程桥
 * 仅暴露 invoke / on 通道，不把 Node 能力泄漏给网页（contextIsolation + sandbox）
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';

const invoke = <T = any>(channel: string, ...args: any[]): Promise<T> => ipcRenderer.invoke(channel, ...args);

const on = (channel: string, callback: (...args: any[]) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, ...args: any[]) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

// Electron 32 起 File.path 被移除：拖放文件必须用 webUtils.getPathForFile 取真实路径
const getDropPaths = (files: FileList | File[]): string[] =>
  Array.from(files)
    .map(file => webUtils.getPathForFile(file))
    .filter(p => typeof p === 'string' && p.length > 0);

contextBridge.exposeInMainWorld('mcl', { invoke, on, getDropPaths });
