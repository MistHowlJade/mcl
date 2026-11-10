/**
 * Preload：唯一的渲染进程桥
 * 仅暴露 invoke / on 通道，不把 Node 能力泄漏给网页（contextIsolation + sandbox）
 */
import { contextBridge, ipcRenderer } from 'electron';

const invoke = <T = any>(channel: string, ...args: any[]): Promise<T> => ipcRenderer.invoke(channel, ...args);

const on = (channel: string, callback: (...args: any[]) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, ...args: any[]) => callback(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('mcl', { invoke, on });
