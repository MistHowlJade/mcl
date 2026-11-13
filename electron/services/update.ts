/**
 * 启动器更新检查与安装包下载
 * - 读取 GitHub 最新 Release，做语义化版本比较
 * - 不自动替换程序文件：只下载到系统下载目录，由用户确认后手动安装
 * - 支持代理（走 net/downloader 的统一网络层）
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { fetchWithTimeout } from './net';
import { DownloadManager } from './downloader';
import { UpdateInfo } from '../shared/types';

const REPO = 'MistHowlJade/mcl';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;

interface GithubAsset {
  name?: string;
  browser_download_url?: string;
  size?: number;
}

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubAsset[];
}

/** 比较 a/b，返回 1/0/-1（忽略前缀 v 与预发布后缀） */
function compareVersions(a: string, b: string): number {
  const normalize = (v: string) => v.replace(/^v/i, '').split(/[-+]/)[0].split('.').map(x => parseInt(x, 10) || 0);
  const pa = normalize(a);
  const pb = normalize(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export async function checkUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion();
  let res;
  try {
    res = await fetchWithTimeout(LATEST_API, {
      timeoutMs: 15000,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'MCL-Launcher',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (e) {
    throw new Error(`无法连接 GitHub 检查更新：${e instanceof Error ? e.message : e}\n你可以手动打开 ${RELEASES_URL} 查看最新版本。`);
  }
  if (res.status === 404) {
    return { current, latest: null, hasUpdate: false, url: RELEASES_URL, notes: null, publishedAt: null, assets: [] };
  }
  if (res.status === 403) {
    throw new Error('GitHub API 触发了限流（HTTP 403），请稍后再试，或手动打开 Release 页面查看。');
  }
  if (res.status >= 400) {
    throw new Error(`GitHub 返回 HTTP ${res.status}，暂时无法检查更新。`);
  }
  let release: GithubRelease;
  try {
    release = JSON.parse(res.body.toString('utf8')) as GithubRelease;
  } catch {
    throw new Error('GitHub 返回内容无法解析，请稍后再试。');
  }
  const latest = String(release.tag_name ?? release.name ?? '').trim() || null;
  const hasUpdate = !!latest && compareVersions(latest, current) > 0;
  const assets = (release.assets ?? [])
    .filter(a => a.name && a.browser_download_url && !/\.(sha\d*|sig|blockmap|yml|yaml|json|txt)$/i.test(a.name))
    .map(a => ({ name: a.name!, url: a.browser_download_url!, sizeBytes: a.size ?? null }));
  return {
    current,
    latest,
    hasUpdate,
    url: release.html_url ?? RELEASES_URL,
    notes: (release.body ?? '').slice(0, 4000) || null,
    publishedAt: release.published_at ?? null,
    assets,
  };
}

/** 选择最适合当前系统的安装包：Windows exe → msi → zip，其它平台 dmg/AppImage/zip */
function pickAsset(assets: UpdateInfo['assets']): UpdateInfo['assets'][number] | null {
  if (!assets.length) return null;
  const platform = process.platform;
  const patterns: RegExp[] = platform === 'win32'
    ? [/setup.*\.exe$/i, /\.exe$/i, /\.msi$/i, /win.*\.zip$/i, /\.zip$/i]
    : platform === 'darwin'
      ? [/\.dmg$/i, /mac.*\.zip$/i, /\.zip$/i]
      : [/\.AppImage$/i, /linux.*\.zip$/i, /\.zip$/i];
  for (const pattern of patterns) {
    const hit = assets.find(a => pattern.test(a.name));
    if (hit) return hit;
  }
  return null;
}

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  let target = path.join(dir, name);
  let i = 1;
  while (fs.existsSync(target)) target = path.join(dir, `${base} (${i++})${ext}`);
  return target;
}

export interface UpdateDownloadResult {
  filePath: string;
  fileName: string;
  sizeBytes: number;
}

/** 下载最新版安装包到系统下载目录（不执行、不替换程序） */
export async function downloadUpdate(onProgress?: (done: number, total: number) => void): Promise<UpdateDownloadResult> {
  const info = await checkUpdate();
  if (!info.hasUpdate) throw new Error('当前已是最新版本，无需下载更新。');
  const asset = pickAsset(info.assets);
  if (!asset) {
    throw new Error(`该版本没有可直接下载的安装包。\n请打开 Release 页面手动下载：${info.url ?? RELEASES_URL}`);
  }
  const safeName = asset.name.replace(/[<>:"/\\|?*]/g, '_');
  const dest = uniquePath(app.getPath('downloads'), safeName);
  const dl = new DownloadManager({
    source: 'official',
    maxThreads: 4,
    retries: 3,
    timeoutMs: 60000,
  });
  dl.on('progress', () => {
    const totals = dl.totals;
    onProgress?.(totals.done, totals.total);
  });
  const reports = await dl.run([{
    id: `mcl-update:${asset.name}`,
    url: asset.url,
    dest,
    name: asset.name,
    size: asset.sizeBytes ?? undefined,
  }]);
  const report = reports[0];
  if (!report?.ok) {
    throw new Error(`更新包下载失败：${report?.error ?? '未知错误'}\n可打开 Release 页面手动下载：${info.url ?? RELEASES_URL}`);
  }
  onProgress?.(report.bytes, report.bytes);
  return { filePath: dest, fileName: path.basename(dest), sizeBytes: report.bytes };
}

export const releasePage = RELEASES_URL;