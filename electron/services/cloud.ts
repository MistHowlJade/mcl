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

/** 与实例/服务端创建时的校验保持一致：版本号会进入 URL 与安装器参数 */
const isMcVersion = (v: unknown): v is string => typeof v === 'string'
  && v.length > 0 && v.length <= 128
  && /^[0-9A-Za-z_\-[\]]+(\.[0-9A-Za-z_\-[\]]+)*$/.test(v);
/** 加载器版本只允许普通版本号字符：不能以 - 开头，避免被当成额外的安装器参数 */
const isLoaderVersion = (v: unknown): v is string => typeof v === 'string'
  && /^[0-9A-Za-z][0-9A-Za-z._+\-]{0,63}$/.test(v);

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
  // 本机 Java 路径属于设备信息：不随快照上传，恢复时也保留目标机器自己的选择
  const instances = listInstanceFiles().map(cfg => {
    const copy = JSON.parse(JSON.stringify(cfg)) as Record<string, any>;
    copy.javaPath = null;
    return copy;
  });
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
  const entries: Array<{ name: string; data: Buffer; mtime?: Date }> = [];
  const failedSaves: string[] = [];
  for (const save of saveDirs) {
    try {
      entries.push({ name: `saves/${save.instanceId}.zip`, data: zipFromDir(save.dir), mtime: new Date() });
    } catch {
      // 绝不能静默丢存档：打包失败要写进 manifest 警告，并在界面明确提示
      failedSaves.push(save.instanceId);
    }
  }
  if (failedSaves.length > 0) {
    manifest.warnings = [
      ...(manifest.warnings ?? []),
      `以下实例的存档打包失败，快照未包含：${failedSaves.join('、')}。请检查目录权限或磁盘空间后重试上传。`,
    ];
  }
  // manifest 必须在存档打包完成后再序列化，才能把上面的警告写进去
  entries.unshift({ name: 'mcl-cloud.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), mtime: new Date() });
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
  // warnings 会直接渲染到界面：快照可能被手工改坏，非字符串条目必须过滤，否则 React 渲染对象会白屏
  const warnings: string[] = Array.isArray(manifest.warnings)
    ? manifest.warnings.filter((w): w is string => typeof w === 'string')
    : [];
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
  const appliedInstanceIds = new Set<string>();
  for (const rawItem of rawInstances) {
    const raw = (rawItem && typeof rawItem === 'object') ? rawItem : {};
    const id = String(raw?.id ?? '');
    if (!/^[a-f0-9]{16}$/.test(id)) { warnings.push('已跳过非法实例 ID'); continue; }
    const existingFile = paths.instanceFile(id);
    const existing = readJson<any | null>(existingFile, null);
    const rawVersion = typeof raw.mcVersion === 'string' ? raw.mcVersion.trim() : '';
    const existingVersion = typeof existing?.mcVersion === 'string' ? existing.mcVersion : '';
    const mcVersion = isMcVersion(rawVersion) ? rawVersion : (isMcVersion(existingVersion) ? existingVersion : '');
    if (!mcVersion) { warnings.push(`已跳过缺少有效 MC 版本的实例 ${id}`); continue; }
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
      loaderVersion: loader === 'vanilla' || !isLoaderVersion(loaderVersionRaw) ? null : loaderVersionRaw,
      memoryPreset: presetRaw === 'low' || presetRaw === 'standard' || presetRaw === 'heavy' ? presetRaw : 'standard',
      createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : (Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now()),
      lastPlayedAt: Number.isFinite(raw.lastPlayedAt) ? raw.lastPlayedAt : (Number.isFinite(existing?.lastPlayedAt) ? existing.lastPlayedAt : null),
      playTimeSeconds: Number.isFinite(raw.playTimeSeconds) ? Math.max(0, raw.playTimeSeconds) : (Number.isFinite(existing?.playTimeSeconds) ? existing.playTimeSeconds : 0),
      // Java 路径是本机设备信息：绝不采用快照里的值，只保留目标机器已有配置
      javaPath: typeof existing?.javaPath === 'string' ? existing.javaPath : null,
    };
    if (merged.javaPath && !fs.existsSync(String(merged.javaPath))) merged.javaPath = null;
    fs.mkdirSync(paths.gameDir(id), { recursive: true });
    for (const sub of paths.GAME_SUBDIRS) fs.mkdirSync(path.join(paths.gameDir(id), sub), { recursive: true });
    writeJson(existingFile, merged);
    instancesApplied++;
    appliedInstanceIds.add(id);
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
    const rawVersion = typeof mcVersionRaw === 'string' ? mcVersionRaw.trim() : '';
    const existingVersion = typeof existing?.mcVersion === 'string' ? existing.mcVersion : '';
    const serverVersion = isMcVersion(rawVersion) ? rawVersion : (isMcVersion(existingVersion) ? existingVersion : '');
    if (!serverVersion) { warnings.push(`已跳过缺少有效 MC 版本的服务器 ${id}`); continue; }
    const merged = {
      ...(existing ?? {}),
      ...raw,
      id,
      name: (typeof nameRaw === 'string' ? nameRaw.trim().slice(0, 80) : '') || 'MCL 服务器',
      mcVersion: serverVersion,
      loader: ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(loaderRaw) ? loaderRaw : 'vanilla',
      loaderVersion: isLoaderVersion(raw.loaderVersion) ? raw.loaderVersion
        : (isLoaderVersion(existing?.loaderVersion) ? existing.loaderVersion : null),
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
      // 快照可以手工编辑：只恢复本次清单里真实存在的实例，避免凭空创建幽灵存档目录
      if (!appliedInstanceIds.has(instanceId)) {
        warnings.push(`已跳过未知实例 ${instanceId} 的存档`);
        continue;
      }
      const savesDir = path.join(paths.gameDir(instanceId), 'saves');
      // 临时目录放在备份目录：恢复中途失败不会被游戏当成一个真实世界
      const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const tempRoot = paths.instanceBackupsDir(instanceId);
      const tempDir = path.join(tempRoot, `.cloud-${suffix}`);
      try {
        fs.mkdirSync(tempDir, { recursive: true });
        const written = zipExtractAll(buf, tempDir);
        if (written.length === 0) continue;
        // 归档内容就是 saves 下的世界目录。直接往 saves 里覆盖会把快照里已不存在的
        // 旧区块留在原地，恢复出“半新半旧”的世界；这里逐个世界整体替换。
        // 只接受带 level.dat 的顶层目录，快照被手工塞入的杂物不能顶掉本机世界。
        const tops = Array.from(new Set(written.map(p => path.relative(tempDir, p).split(path.sep)[0])))
          .filter(top => {
            if (!top || top === '.' || top === '..') return false;
            const src = path.join(tempDir, top);
            try { return fs.statSync(src).isDirectory() && fs.existsSync(path.join(src, 'level.dat')); } catch { return false; }
          });
        if (tops.length === 0) {
          warnings.push(`实例 ${instanceId} 的存档包里没有识别出有效世界（缺少 level.dat），已跳过`);
          continue;
        }
        fs.mkdirSync(savesDir, { recursive: true });
        let restored = 0;
        for (let i = 0; i < tops.length; i++) {
          const top = tops[i];
          const src = path.join(tempDir, top);
          const target = path.join(savesDir, top);
          if (!fs.existsSync(src)) continue;
          const oldDir = path.join(tempRoot, `.cloud-old-${suffix}-${i}`);
          // 恢复前先给本机同名世界留一份可一键恢复的备份，误操作不至于永久丢存档
          if (fs.existsSync(target)) {
            const backupPath = path.join(tempRoot, `world-${suffix}-${i}.zip`);
            fs.writeFileSync(backupPath, zipFromDir(target));
            writeJson(backupPath.replace(/\.zip$/, '.json'), {
              name: `云恢复前自动备份：${path.basename(target)}`,
              createdAt: Date.now(),
              worldNames: [top],
              kind: 'world',
            });
            fs.renameSync(target, oldDir);
          }
          try {
            fs.renameSync(src, target);
            restored++;
          } catch (e) {
            // 替换失败时把原世界放回去，不能留下世界目录已消失的状态
            if (fs.existsSync(oldDir)) { try { fs.renameSync(oldDir, target); } catch { /* ignore */ } }
            throw e;
          }
          try { fs.rmSync(oldDir, { recursive: true, force: true }); } catch { /* 旧世界清理失败不影响已完成的恢复 */ }
        }
        if (restored > 0) savesApplied++;
      } catch (e) {
        warnings.push(`恢复实例 ${instanceId} 的存档失败：${e instanceof Error ? e.message : e}`);
      } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
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
      if (res.status >= 400 && res.status !== 404) return { ok: false, message: `WebDAV 返回 HTTP ${res.status}，连接不可用（如 405 表示服务端不支持 HEAD，请改用支持 WebDAV 的服务或检查地址）` };
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
      // 私有 Gist 的 raw_url 在 gist.githubusercontent.com，不能把 Token 带过去，
      // 于是取回的是 404 页面；这种情况应该说清楚是快照太大，而不是笼统报 JSON 损坏。
      if (file.truncated) {
        throw new Error('云端配置快照超过 Gist 单文件限制，无法完整读取（私有 Gist 的 raw 链接需要单独认证）。\n请改用 WebDAV 同步，或在上传前清理不再使用的实例/服务器后重新上传。');
      }
      throw new Error('Gist 里的 mcl-config.json 不是有效 JSON，内容可能已损坏。');
    }
    const result = applyManifest(manifest);
    updateSettings({ cloud: { ...getSettings().cloud, lastSyncAt: Date.now(), lastSyncDirection: 'download' } });
    return result;
  }
  throw new Error('还没有选择云同步方式');
}