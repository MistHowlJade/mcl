/**
 * 启动器更新检查：读取 GitHub 最新 Release，做语义化版本比较
 * 不自动下载/安装（避免供应链风险），只提示并打开官方 Release 页面。
 */
import { app } from 'electron';
import { fetchWithTimeout } from './net';
import { UpdateInfo } from '../shared/types';

const REPO = 'MistHowlJade/mcl';
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases`;

interface GithubRelease {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
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
    return { current, latest: null, hasUpdate: false, url: RELEASES_URL, notes: null, publishedAt: null };
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
  return {
    current,
    latest,
    hasUpdate,
    url: release.html_url ?? RELEASES_URL,
    notes: (release.body ?? '').slice(0, 4000) || null,
    publishedAt: release.published_at ?? null,
  };
}

export const releasePage = RELEASES_URL;