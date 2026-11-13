/**
 * 云同步：WebDAV（完整快照，可含存档）+ GitHub Gist（仅配置）
 *
 * 安全边界：
 * - 绝不上传 accounts.json（微软令牌）
 * - 绝不上传 CurseForge API Key、云同步密码 / PAT
 * - 下载后只覆盖 MCL 自己的配置，不执行任何远程脚本
 */
import * as fs from 'fs';
import * as path from 'path';
import * as paths from './paths';
import { readJson, writeJson } from './store';
import { getSettings, updateSettings } from './settings';
import { listInstanceFiles } from './instances';
import { zipFromDir, zipWrite, zipList, zipExtractEntry, zipExtractAll } from './zip';
import { fetchWithTimeout, fetchJson, USER_AGENT } from './net';
import { AppSettings, CloudSnapshotInfo, ServerConfig } from '../shared/types';

const GIST_API = 'https://api.github.com';

interface CloudManifest {
  format: 'mcl-cloud';
  version: 1;
  createdAt: number;
  appVersion: string;
  settings: AppSettings;
  instances: Array<Record<string, any>>;
  servers: ServerConfig[];
  /** 存档归档文件名（WebDAV 快照内） */
  saveArchives: string[];
  warnings?: string[];
}

export interface CloudApplyResult {
  applied: boolean;
  settings: boolean;
  instances: number;
  servers: number;
  saves: number;
  warnings: string[];
}

/* ------------------------------ 配置与安全 ------------------------------ */

function sanitizeSettings(settings: AppSettings): AppSettings {
  const clone = JSON.parse(JSON.stringify(settings)) as AppSettings;
  clone.cloud = {
    ...clone.cloud,
    provider: 'off',
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    gistToken: '',
    gistId: '',
    lastSyncAt: null,
    lastSyncDirection: null,
  };
  clone.curseforge.apiKey = '';
  return clone;
}

function webdavEndpoint(): string {
  const s = getSettings().cloud;
  const base = (s.webdavUrl || '').trim();
  if (!base) throw new Error('还没有填写 WebDAV 地址（设置 → 云同步）');
  if (/\/[^/]+\.zip$/i.test(base)) return base;
  return `${base.replace(/\/+$/, '')}/mcl-snapshot.zip`;
}

function webdavHeaders(): Record<string, string> {
  const s = getSettings().cloud;
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: '*/*' };
  if (s.webdavUsername || s.webdavPassword) {
    headers.Authorization = `Basic ${Buffer.from(`${s.webdavUsername}:${s.webdavPassword}`).toString('base64')}`;
  }
  return headers;
}

function gistHeaders(): Record<string, string> {
  const token = getSettings().cloud.gistToken.trim();
  if (!token) throw new Error('还没有填写 GitHub Token（设置 → 云同步）');
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json; charset=utf-8',
  };
}

/* ------------------------------ 快照构建 / 应用 ------------------------------ */

function buildManifest(includeSaves: boolean): { manifest: CloudManifest; saveDirs: Array<{ instanceId: string; dir: string }> } {
  const settings = getSettings();
  const instances = listInstanceFiles().map(cfg => JSON.parse(JSON.stringify(cfg)));
  const servers = listServersConfig();
  const saveDirs: Array<{ instanceId: string; dir: string }> = [];
  if (includeSaves) {
    for (const inst of instances) {
      const saves = path.join(paths.gameDir(inst.id), 'saves');
      if (fs.existsSync(saves) && fs.readdirSync(saves).length > 0) saveDirs.push({ instanceId: inst.id, dir: saves });
    }
  }
  const manifest: CloudManifest = {
    format: 'mcl-cloud',
    version: 1,
    createdAt: Date.now(),
    appVersion: '0.1.0',
    settings: sanitizeSettings(settings),
    instances,
    servers,
    saveArchives: saveDirs.map(s => `saves/${s.instanceId}.zip`),
    warnings: saveDirs.length > 0 ? ['存档已打包进快照；体积可能较大。'] : undefined,
  };
  return { manifest, saveDirs };
}

function listServersConfig(): ServerConfig[] {
  const root = paths.serversDir();
  if (!fs.existsSync(root)) return [];
  const out: ServerConfig[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfg = readJson<ServerConfig | null>(paths.serverFile(entry.name), null);
    if (!cfg) continue;
    out.push({ ...cfg, javaPath: null, prepared: false, eulaAccepted: false });
  }
  return out;
}

export function buildConfigOnlyJson(): string {
  const { manifest } = buildManifest(false);
  return JSON.stringify(manifest, null, 2);
}

export function buildFullSnapshotZip(): Buffer {
  const { manifest, saveDirs } = buildManifest(getSettings().cloud.includeSaves);
  const entries: Array<{ name: string; data: Buffer; mtime?: Date }> = [
    { name: 'mcl-cloud.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: new Date() },
  ];
  for (const save of saveDirs) {
    try {
      entries.push({ name: `saves/${save.instanceId}.zip`, data: zipFromDir(save.dir), mtime: new Date() });
    } catch { /* 单个存档打包失败不阻塞其它实例 */ }
  }
  return zipWrite(entries);
}

function mergeSettings(incoming: AppSettings): void {
  const local = getSettings();
  const safeIncoming = sanitizeSettings(incoming);
  // 云凭据永远保留本机的，不采用远端
  const next: AppSettings = {
    ...local,
    general: { ...local.general, ...safeIncoming.general },
    download: { ...local.download, ...safeIncoming.download },
    java: { ...local.java, ...safeIncoming.java },
    launch: { ...local.launch, ...safeIncoming.launch },
    curseforge: { ...local.curseforge, apiKey: local.curseforge.apiKey },
    migration: { ...local.migration, ...safeIncoming.migration },
    cloud: local.cloud,
  };
  updateSettings(next as any);
}

function applyManifest(manifest: CloudManifest, saveArchives?: Map<string, Buffer>): CloudApplyResult {
  const warnings: string[] = [...(manifest.warnings ?? [])];
  if (manifest.format !== 'mcl-cloud' || manifest.version !== 1) {
    throw new Error('这不是 MCL 云同步快照（格式不匹配）');
  }
  let settingsApplied = false;
  if (manifest.settings) {
    mergeSettings(manifest.settings);
    settingsApplied = true;
  }

  let instancesApplied = 0;
  for (const raw of manifest.instances ?? []) {
    const id = String(raw?.id ?? '');
    if (!/^[a-f0-9]{16}$/.test(id)) { warnings.push('已跳过非法实例 ID'); continue; }
    const existingFile = paths.instanceFile(id);
    const existing = readJson<any | null>(existingFile, null);
    const merged = {
      ...(existing ?? {}),
      ...raw,
      id,
      createdAt: existing?.createdAt ?? raw.createdAt ?? Date.now(),
    };
    if (merged.javaPath && !fs.existsSync(String(merged.javaPath))) merged.javaPath = null;
    fs.mkdirSync(paths.gameDir(id), { recursive: true });
    for (const sub of paths.GAME_SUBDIRS) fs.mkdirSync(path.join(paths.gameDir(id), sub), { recursive: true });
    writeJson(existingFile, merged);
    instancesApplied++;
  }

  let serversApplied = 0;
  for (const raw of manifest.servers ?? []) {
    const id = String(raw?.id ?? '');
    if (!/^[a-f0-9]{16}$/.test(id)) continue;
    const existing = readJson<ServerConfig | null>(paths.serverFile(id), null);
    const merged: ServerConfig = {
      ...(existing ?? (raw as ServerConfig)),
      ...raw,
      id,
      prepared: false,
      eulaAccepted: false,
      javaPath: existing?.javaPath ?? null,
    };
    fs.mkdirSync(paths.serverDir(id), { recursive: true });
    writeJson(paths.serverFile(id), merged);
    serversApplied++;
  }

  let savesApplied = 0;
  if (saveArchives && saveArchives.size > 0) {
    for (const [instanceId, buf] of saveArchives) {
      try {
        const savesDir = path.join(paths.gameDir(instanceId), 'saves');
        fs.mkdirSync(savesDir, { recursive: true });
        // 归档内容就是 saves 下的世界目录；zipExtractAll 自带目录穿越防护
        const written = zipExtractAll(buf, savesDir);
        if (written.length > 0) savesApplied++;
      } catch (e) {
        warnings.push(`恢复实例 ${instanceId} 的存档失败：${e instanceof Error ? e.message : e}`);
      }
    }
  }

  return { applied: true, settings: settingsApplied, instances: instancesApplied, servers: serversApplied, saves: savesApplied, warnings };
}

/* ------------------------------ WebDAV ------------------------------ */

export async function testCloud(): Promise<{ ok: boolean; message: string }> {
  const settings = getSettings();
  if (settings.cloud.provider === 'webdav') {
    const url = webdavEndpoint();
    try {
      const res = await fetchWithTimeout(url, { method: 'HEAD', headers: webdavHeaders(), timeoutMs: 15000 });
      if (res.status === 401 || res.status === 403) return { ok: false, message: `WebDAV 认证失败（HTTP ${res.status}），请检查用户名/密码` };
      if (res.status >= 500) return { ok: false, message: `WebDAV 服务器错误（HTTP ${res.status}）` };
      return { ok: true, message: res.status === 404 ? '连接成功（云端还没有快照）' : `连接成功（HTTP ${res.status}）` };
    } catch (e) {
      return { ok: false, message: `无法连接 WebDAV：${e instanceof Error ? e.message : e}` };
    }
  }
  if (settings.cloud.provider === 'gist') {
    try {
      const gists = await fetchJson<Array<{ id: string }>>(`${GIST_API}/gists?per_page=1`, { headers: gistHeaders(), timeoutMs: 15000 });
      return { ok: true, message: `连接成功（可访问 ${Array.isArray(gists) ? gists.length : 0} 个 Gist）` };
    } catch (e) {
      return { ok: false, message: `GitHub Token 无效或网络不可达：${e instanceof Error ? e.message : e}` };
    }
  }
  return { ok: false, message: '还没有选择云同步方式' };
}

export async function inspectCloud(): Promise<CloudSnapshotInfo> {
  const settings = getSettings();
  if (settings.cloud.provider === 'webdav') {
    const url = webdavEndpoint();
    try {
      const res = await fetchWithTimeout(url, { method: 'HEAD', headers: webdavHeaders(), timeoutMs: 15000 });
      if (res.status === 404) return { exists: false, updatedAt: null, sizeBytes: null, location: url, note: '云端还没有快照' };
      if (res.status >= 400) return { exists: false, updatedAt: null, sizeBytes: null, location: url, note: `HTTP ${res.status}` };
      const modified = res.headers['last-modified'] ? new Date(String(res.headers['last-modified'])).getTime() : null;
      const size = parseInt(String(res.headers['content-length'] ?? '0'), 10) || null;
      return { exists: true, updatedAt: Number.isFinite(modified) ? modified : null, sizeBytes: size, location: url, note: 'WebDAV 完整快照' };
    } catch (e) {
      return { exists: false, updatedAt: null, sizeBytes: null, location: url, note: `连接失败：${e instanceof Error ? e.message : e}` };
    }
  }
  if (settings.cloud.provider === 'gist') {
    const id = settings.cloud.gistId.trim();
    if (!id) return { exists: false, updatedAt: null, sizeBytes: null, location: '（首次上传时自动创建 Gist）', note: '还没有 Gist ID' };
    try {
      const gist = await fetchJson<any>(`${GIST_API}/gists/${id}`, { headers: gistHeaders(), timeoutMs: 15000 });
      const file = gist?.files?.['mcl-config.json'];
      return {
        exists: !!file,
        updatedAt: gist?.updated_at ? new Date(gist.updated_at).getTime() : null,
        sizeBytes: file?.size ?? null,
        location: `https://gist.github.com/${id}`,
        note: 'GitHub Gist 配置快照',
      };
    } catch (e) {
      return { exists: false, updatedAt: null, sizeBytes: null, location: id, note: `读取失败：${e instanceof Error ? e.message : e}` };
    }
  }
  return { exists: false, updatedAt: null, sizeBytes: null, location: '', note: '未配置云同步' };
}

export async function uploadCloud(): Promise<CloudSnapshotInfo> {
  const settings = getSettings();
  if (settings.cloud.provider === 'webdav') {
    const buf = buildFullSnapshotZip();
    const url = webdavEndpoint();
    const res = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: { ...webdavHeaders(), 'Content-Type': 'application/zip', 'Content-Length': String(buf.length) },
      body: buf,
      timeoutMs: 120000,
    });
    if (res.status >= 400) throw new Error(`WebDAV 上传失败（HTTP ${res.status}）`);
    updateSettings({ cloud: { ...getSettings().cloud, lastSyncAt: Date.now(), lastSyncDirection: 'upload' } });
    return inspectCloud();
  }
  if (settings.cloud.provider === 'gist') {
    const content = buildConfigOnlyJson();
    const headers = gistHeaders();
    let id = settings.cloud.gistId.trim();
    if (id) {
      const res = await fetchWithTimeout(`${GIST_API}/gists/${id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ files: { 'mcl-config.json': { content } } }), timeoutMs: 30000,
      });
      if (res.status >= 400) throw new Error(`Gist 更新失败（HTTP ${res.status}）`);
    } else {
      const res = await fetchWithTimeout(`${GIST_API}/gists`, {
        method: 'POST', headers,
        body: JSON.stringify({ description: 'MCL 启动器配置快照（不含令牌与密钥）', public: false, files: { 'mcl-config.json': { content } } }),
        timeoutMs: 30000,
      });
      if (res.status >= 400) throw new Error(`Gist 创建失败（HTTP ${res.status}）`);
      const json = JSON.parse(res.body.toString('utf8'));
      id = json.id;
      if (!id) throw new Error('Gist 创建成功但没有返回 ID');
    }
    updateSettings({ cloud: { ...getSettings().cloud, gistId: id, lastSyncAt: Date.now(), lastSyncDirection: 'upload' } });
    return inspectCloud();
  }
  throw new Error('还没有选择云同步方式');
}

export async function downloadCloud(): Promise<CloudApplyResult> {
  const settings = getSettings();
  if (settings.cloud.provider === 'webdav') {
    const res = await fetchWithTimeout(webdavEndpoint(), { method: 'GET', headers: webdavHeaders(), timeoutMs: 120000 });
    if (res.status === 404) throw new Error('云端还没有快照，请先上传一次');
    if (res.status >= 400) throw new Error(`WebDAV 下载失败（HTTP ${res.status}）`);
    const buf = res.body;
    const entries = zipList(buf);
    const manifestEntry = entries.find(e => e.name.replace(/\\/g, '/') === 'mcl-cloud.json');
    if (!manifestEntry) throw new Error('快照里缺少 mcl-cloud.json，文件可能损坏');
    const manifest = JSON.parse(zipExtractEntry(buf, manifestEntry).toString('utf8')) as CloudManifest;
    const saveArchives = new Map<string, Buffer>();
    for (const entry of entries) {
      const norm = entry.name.replace(/\\/g, '/');
      const hit = norm.match(/^saves\/([a-f0-9]{16})\.zip$/);
      if (hit) saveArchives.set(hit[1], zipExtractEntry(buf, entry));
    }
    const result = applyManifest(manifest, saveArchives);
    updateSettings({ cloud: { ...getSettings().cloud, lastSyncAt: Date.now(), lastSyncDirection: 'download' } });
    return result;
  }
  if (settings.cloud.provider === 'gist') {
    const id = settings.cloud.gistId.trim();
    if (!id) throw new Error('还没有 Gist ID，请先上传一次或手动填写');
    const gist = await fetchJson<any>(`${GIST_API}/gists/${id}`, { headers: gistHeaders(), timeoutMs: 20000 });
    const file = gist?.files?.['mcl-config.json'];
    if (!file) throw new Error('Gist 中找不到 mcl-config.json');
    let content: string | null = file.content ?? null;
    if (file.truncated && file.raw_url) {
      const raw = await fetchWithTimeout(file.raw_url, { headers: gistHeaders(), timeoutMs: 30000 });
      content = raw.body.toString('utf8');
    }
    if (!content) throw new Error('Gist 文件内容为空');
    const manifest = JSON.parse(content) as CloudManifest;
    const result = applyManifest(manifest);
    updateSettings({ cloud: { ...getSettings().cloud, lastSyncAt: Date.now(), lastSyncDirection: 'download' } });
    return result;
  }
  throw new Error('还没有选择云同步方式');
}