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
import { app } from 'electron';
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
  const raw = (settings && typeof settings === 'object' && !Array.isArray(settings)) ? settings : ({} as AppSettings);
  const clone = JSON.parse(JSON.stringify(raw)) as AppSettings;
  // 快照可能被手工编辑或来自旧版本：缺字段时按空对象处理，不能让合并直接崩掉
  clone.cloud = {
    ...(clone.cloud ?? {}),
    provider: 'off',
    webdavUrl: '',
    webdavUsername: '',
    webdavPassword: '',
    gistToken: '',
    gistId: '',
    lastSyncAt: null,
    lastSyncDirection: null,
  };
  clone.curseforge = { ...(clone.curseforge ?? {}), apiKey: '' };
  clone.network = {
    ...(clone.network ?? {}),
    proxyMode: 'off',
    proxyUrl: '',
    proxyUsername: '',
    proxyPassword: '',
  };
  return clone;
}

function webdavEndpoint(): string {
  const s = getSettings().cloud;
  const raw = (s.webdavUrl || '').trim();
  if (!raw) throw new Error('还没有填写 WebDAV 地址（设置 → 云同步）');
  // 兼容带查询参数/锚点的地址（部分网盘的分享链接会带 token），文件路径必须拼在查询参数前面
  const hashAt = raw.indexOf('#');
  const frag = hashAt >= 0 ? raw.slice(hashAt) : '';
  const noFrag = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const qAt = noFrag.indexOf('?');
  const query = qAt >= 0 ? noFrag.slice(qAt) : '';
  const core = qAt >= 0 ? noFrag.slice(0, qAt) : noFrag;
  if (/\.zip$/i.test(core)) return `${core}${query}${frag}`;
  return `${core.replace(/\/+$/, '')}/mcl-snapshot.zip${query}${frag}`;
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
    appVersion: app.getVersion(),
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
    // 损坏/半写入的 server.json 不上传：云端恢复时也会跳过它，没必要污染快照
    if (!cfg || typeof cfg !== 'object') continue;
    if (!/^[a-f0-9]{16}$/.test(String(cfg.id ?? '')) || cfg.id !== entry.name) continue;
    if (typeof cfg.name !== 'string' || typeof cfg.mcVersion !== 'string') continue;
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
    network: local.network,
    cloud: local.cloud,
  };
  updateSettings(next as any);
}

function applyManifest(manifest: CloudManifest, saveArchives?: Map<string, Buffer>): CloudApplyResult {
  if (!manifest || typeof manifest !== 'object') throw new Error('这不是 MCL 云同步快照（内容为空或格式错误）');
  const warnings: string[] = Array.isArray(manifest.warnings) ? [...manifest.warnings] : [];
  if (manifest.format !== 'mcl-cloud' || manifest.version !== 1) {
    throw new Error('这不是 MCL 云同步快照（格式不匹配）');
  }
  let settingsApplied = false;
  if (manifest.settings && typeof manifest.settings === 'object') {
    mergeSettings(manifest.settings);
    settingsApplied = true;
  }

  const rawInstances = Array.isArray(manifest.instances) ? manifest.instances : [];
  if (manifest.instances !== undefined && !Array.isArray(manifest.instances)) warnings.push('快照里的实例列表格式不正确，已跳过');
  let instancesApplied = 0;
  for (const rawItem of rawInstances) {
    const raw = (rawItem && typeof rawItem === 'object') ? rawItem : {};
    const id = String(raw?.id ?? '');
    if (!/^[a-f0-9]{16}$/.test(id)) { warnings.push('已跳过非法实例 ID'); continue; }
    const existingFile = paths.instanceFile(id);
    const existing = readJson<any | null>(existingFile, null);
    const mcVersion = typeof raw.mcVersion === 'string' && raw.mcVersion.trim()
      ? raw.mcVersion.trim()
      : (typeof existing?.mcVersion === 'string' ? existing.mcVersion : '');
    if (!mcVersion) { warnings.push(`已跳过缺少 MC 版本的实例 ${id}`); continue; }
    const loaderRaw = raw.loader ?? existing?.loader;
    const loader = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(loaderRaw) ? loaderRaw : 'vanilla';
    const loaderVersionRaw = raw.loaderVersion ?? existing?.loaderVersion;
    const nameRaw = raw.name ?? existing?.name;
    const presetRaw = raw.memoryPreset ?? existing?.memoryPreset;
    const merged = {
      ...(existing ?? {}),
      ...raw,
      id,
      name: (typeof nameRaw === 'string' ? nameRaw.trim().slice(0, 80) : '')
        || `${mcVersion}${loader !== 'vanilla' ? ' · ' + loader : ''}`,
      mcVersion,
      loader,
      loaderVersion: loader === 'vanilla' || typeof loaderVersionRaw !== 'string' || !loaderVersionRaw ? null : loaderVersionRaw,
      memoryPreset: presetRaw === 'low' || presetRaw === 'standard' || presetRaw === 'heavy' ? presetRaw : 'standard',
      createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : (Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()),
      lastPlayedAt: Number.isFinite(raw.lastPlayedAt) ? raw.lastPlayedAt : (Number.isFinite(existing?.lastPlayedAt) ? existing.lastPlayedAt : null),
      playTimeSeconds: Number.isFinite(raw.playTimeSeconds) ? Math.max(0, raw.playTimeSeconds) : (Number.isFinite(existing?.playTimeSeconds) ? existing.playTimeSeconds : 0),
      javaPath: typeof raw.javaPath === 'string' ? raw.javaPath : (typeof existing?.javaPath === 'string' ? existing.javaPath : null),
    };
    if (merged.javaPath && !fs.existsSync(String(merged.javaPath))) merged.javaPath = null;
    fs.mkdirSync(paths.gameDir(id), { recursive: true });
    for (const sub of paths.GAME_SUBDIRS) fs.mkdirSync(path.join(paths.gameDir(id), sub), { recursive: true });
    writeJson(existingFile, merged);
    instancesApplied++;
  }

  const rawServers = Array.isArray(manifest.servers) ? manifest.servers : [];
  if (manifest.servers !== undefined && !Array.isArray(manifest.servers)) warnings.push('快照里的服务器列表格式不正确，已跳过');
  let serversApplied = 0;
  for (const rawItem of rawServers) {
    const raw = ((rawItem && typeof rawItem === 'object') ? rawItem : {}) as any;
    const id = String(raw?.id ?? '');
    if (!/^[a-f0-9]{16}$/.test(id)) continue;
    const existing = readJson<any | null>(paths.serverFile(id), null);
    const loaderRaw = raw.loader ?? existing?.loader;
    const nameRaw = raw.name ?? existing?.name;
    const port = Number(raw.port ?? existing?.port ?? 25565);
    const memoryMB = Number(raw.memoryMB ?? existing?.memoryMB ?? 4096);
    const mcVersionRaw = raw.mcVersion ?? existing?.mcVersion;
    const merged = {
      ...(existing ?? {}),
      ...raw,
      id,
      name: (typeof nameRaw === 'string' ? nameRaw.trim().slice(0, 80) : '') || 'MCL 服务器',
      mcVersion: typeof mcVersionRaw === 'string' && mcVersionRaw.trim() ? mcVersionRaw.trim() : '1.20.1',
      loader: ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(loaderRaw) ? loaderRaw : 'vanilla',
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 25565,
      memoryMB: Number.isFinite(memoryMB) ? Math.max(512, Math.min(32768, Math.round(memoryMB))) : 4096,
      createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : (Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()),
      prepared: false,
      eulaAccepted: false,
      javaPath: existing?.javaPath ?? null,
    };
    fs.mkdirSync(paths.serverDir(id), { recursive: true });
    writeJson(paths.serverFile(id), merged as ServerConfig);
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
    // 先校验地址再打包（存档快照可能很大，地址没填就别白忙）
    const url = webdavEndpoint();
    const buf = buildFullSnapshotZip();
    const res = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: { ...webdavHeaders(), 'Content-Type': 'application/zip', 'Content-Length': String(buf.length) },
      body: buf,
      timeoutMs: 120000,
    });
    if (res.status === 409 || res.status === 404) {
      throw new Error(`WebDAV 上传失败（HTTP ${res.status}）：目标目录可能不存在。WebDAV 不会自动创建多级目录，请先在网盘里建好文件夹。`);
    }
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
    let manifest: CloudManifest;
    try {
      manifest = JSON.parse(zipExtractEntry(buf, manifestEntry).toString('utf8')) as CloudManifest;
    } catch {
      throw new Error('快照里的 mcl-cloud.json 不是有效 JSON，文件可能已损坏。');
    }
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
      // raw_url 在 gist.githubusercontent.com：不要把 GitHub Token 发给另一个主机
      let rawHeaders: Record<string, string> = {};
      try { if (new URL(file.raw_url).origin === new URL(GIST_API).origin) rawHeaders = gistHeaders(); } catch { /* 非法 URL 交给 fetch 报错 */ }
      const raw = await fetchWithTimeout(file.raw_url, { headers: rawHeaders, timeoutMs: 30000 });
      content = raw.body.toString('utf8');
    }
    if (!content) throw new Error('Gist 文件内容为空');
    let manifest: CloudManifest;
    try {
      manifest = JSON.parse(content) as CloudManifest;
    } catch {
      throw new Error('Gist 里的 mcl-config.json 不是有效 JSON，内容可能已损坏。');
    }
    const result = applyManifest(manifest);
    updateSettings({ cloud: { ...getSettings().cloud, lastSyncAt: Date.now(), lastSyncDirection: 'download' } });
    return result;
  }
  throw new Error('还没有选择云同步方式');
}