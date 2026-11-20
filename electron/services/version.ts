/**
 * 版本清单与版本 JSON 解析（inheritsFrom 合并、规则评估、库/资源规划）
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchJson, lastHealthCheck, mapToMirror, OFFICIAL } from './net';
import { assetsIndexDir, assetsObjectsDir, librariesDir, versionsDir } from './paths';
import { VersionManifestEntry, DownloadSource } from '../shared/types';
import { readJson, writeJson } from './store';

export interface LibraryDownload {
  name: string;            // maven 坐标
  url: string;
  path: string;            // 相对 libraries 的路径
  sha1?: string;
  size?: number;
  isNative: boolean;
  nativeKey?: string;      // 如 natives-windows
}

export interface AssetObject {
  hash: string;
  size: number;
  name: string;            // virtual 路径，仅展示用
}

export interface ResolvedVersion {
  id: string;
  mainClass: string;
  minecraftArguments?: string;          // 旧版（≤1.12.2 风格）
  arguments?: { game?: Array<string | { rules: Rule[]; value: string | string[] }>; jvm?: Array<string | { rules: Rule[]; value: string | string[] }> };
  assets: string;                        // assets index 名
  assetIndex: { id: string; url: string; sha1?: string; size?: number; totalSize?: number };
  downloads: { client: { url: string; sha1: string; size: number } };
  libraries: LibraryDownload[];
  javaVersion?: { component?: string; majorVersion?: number };
  type: string;
  inheritsFrom?: string;
}

export interface Rule {
  action: 'allow' | 'disallow';
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
}

const manifestCacheFile = () => path.join(versionsDir(), '..', 'cache', 'version_manifest.json');

export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: VersionManifestEntry[];
}

export async function getVersionManifest(source: DownloadSource, customMirror?: string): Promise<VersionManifest> {
  const cache = readJson<{ at: number; manifest: VersionManifest } | null>(manifestCacheFile(), null);
  if (cache && Date.now() - cache.at < 30 * 60 * 1000
    && cache.manifest && Array.isArray(cache.manifest.versions)) {
    return cache.manifest;
  }
  const url = resolveSourceUrl(OFFICIAL.versionManifest, source, customMirror);
  const manifest = await fetchJson<VersionManifest>(url, { timeoutMs: 20000 });
  if (!manifest || !Array.isArray(manifest.versions)) {
    throw new Error('版本清单格式不正确（缺少 versions 列表），请更换下载源或稍后重试。');
  }
  try {
    writeJson(manifestCacheFile(), { at: Date.now(), manifest });
  } catch { /* 缓存失败不阻塞 */ }
  return manifest;
}

/** auto 模式实际生效源：读最近测速缓存（无测速或过期则默认 BMCLAPI，mirror:test 可刷新） */
export function getAutoSource(): 'bmclapi' | 'official' {
  // 走 net.ts 的统一健康缓存，避免路径各写一份导致读不到测速结果
  try {
    const health = lastHealthCheck();
    if (health && Date.now() - health.at < 10 * 60 * 1000) {
      const okList = health.latencies.filter(l => l.ok);
      if (okList.length === 2) return okList[0].latencyMs <= okList[1].latencyMs ? okList[0].source : okList[1].source;
      if (okList.length === 1) return okList[0].source;
    }
  } catch { /* 缓存异常不阻塞 */ }
  return 'bmclapi';
}

export function resolveSourceUrl(officialUrl: string, source: DownloadSource, customMirror?: string): string {
  if (source === 'official') return officialUrl;
  if (source === 'auto') return mapToMirror(officialUrl, getAutoSource());
  if (source === 'bmclapi') return mapToMirror(officialUrl, 'bmclapi');
  if (source === 'custom' && customMirror) return mapToMirror(officialUrl, 'custom', customMirror);
  return officialUrl;
}

/* ---------- 规则评估 ---------- */
/**
 * evalRule 语义 = "规则条件是否适用"（不是"是否允许启动"）：
 *   - 条件匹配 → true（规则生效，由 evalRules 按 action 决定允许性）
 *   - 条件不匹配 → false（规则不适用）
 * 每条规则独立求值，互不依赖 action。
 */
export function evalRule(rule: Rule, features: Record<string, boolean> = {}): boolean {
  if (rule.os) {
    const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    if (rule.os.name && rule.os.name !== osName) return false;
    if (rule.os.arch) {
      const arch = process.arch;
      const want = typeof rule.os.arch === 'string' ? rule.os.arch.toLowerCase() : '';
      if (want === 'x86') { if (arch !== 'ia32' && arch !== 'arm') return false; }
      else if (want === 'x64' || want === 'x86_64' || want === 'amd64') { if (arch !== 'x64') return false; }
      else if (want === 'arm64' || want === 'aarch64') { if (arch !== 'arm64') return false; }
      // 未覆盖的 arch 不作判断（交给上层按不匹配处理见 MOJANG 规范需谨慎，但不拦截）
    }
    if (rule.os.version) {
      try {
        const sysVer = process.getSystemVersion ? process.getSystemVersion() : '';
        if (sysVer && !new RegExp(rule.os.version).test(sysVer)) return false;
      } catch { /* 正则非法时不拦截 */ }
    }
  }
  if (rule.features) {
    for (const key of Object.keys(rule.features)) {
      if (!!features[key] !== !!rule.features[key]) return false;
    }
  }
  return true;
}

export function evalRules(rules: Rule[] | undefined, features: Record<string, boolean> = {}): boolean {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const applies = evalRule(rule, features);
    if (applies) allowed = rule.action === 'allow';
  }
  return allowed;
}

const PRERELEASE = /-(?:alpha|beta|pre|preview|rc|snapshot)\d*(?:[.\-+]|$)/i;

/**
 * Maven 元数据里的 <version> 不保证按版本号排序：数字感知比较取最新，避免 47.10 被 47.9 盖住。
 * NeoForge/Quilt 的元数据同时列有 -beta：界面承诺“最新稳定版”，有正式版时不能自动选测试版。
 */
export function newestVersion(versions: string[]): string | undefined {
  const stable = versions.filter(v => !PRERELEASE.test(String(v)));
  const pool = stable.length > 0 ? stable : versions;
  return pool.reduce<string | undefined>(
    (best, v) => (best === undefined || String(v).localeCompare(best, 'en', { numeric: true }) > 0 ? v : best),
    undefined,
  );
}

/** 合并加载器 profile json（fabric/quilt/forge）到已解析的基础版本上 */
export function mergeProfile(base: Record<string, any>, profile: Record<string, any>): Record<string, any> {
  const merged = mergeVersionJson(profile, base);
  // profile 的 inheritsFrom 不应覆盖基础解析
  delete merged.inheritsFrom;
  return merged;
}

/* ---------- inheritsFrom 合并 ---------- */
/**
 * 库去重键：group:artifact[:classifier][@ext]。
 * inheritsFrom 的常见场景是子版本用同坐标、不同版本覆盖父版本库（Forge 补丁库），
 * 直接拼接会让旧版库先进入 classpath；这里保留子版本。classifier 不同的 native 库不受影响。
 */
function libraryKey(lib: Record<string, any>): string {
  const raw = String(lib?.name ?? '');
  if (!raw) return `raw:${JSON.stringify(lib)}`;
  const at = raw.indexOf('@');
  const ext = at >= 0 ? raw.slice(at + 1) : 'jar';
  const parts = (at >= 0 ? raw.slice(0, at) : raw).split(':');
  if (parts.length >= 2) return `${parts[0]}:${parts[1]}:${parts[3] ?? ''}:${ext}`;
  return raw;
}

function mergeVersionJson(child: Record<string, any>, parent: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...parent, ...child };
  // libraries 按坐标去重：父在前，子覆盖同坐标的版本（Map.set 保留父条目顺序）
  const libs = new Map<string, Record<string, any>>();
  const parentLibs = Array.isArray(parent.libraries) ? parent.libraries : [];
  const childLibs = Array.isArray(child.libraries) ? child.libraries : [];
  for (const lib of [...parentLibs, ...childLibs]) {
    if (lib && typeof lib === 'object') libs.set(libraryKey(lib), lib);
  }
  merged.libraries = [...libs.values()];
  // arguments 合并
  if (parent.arguments || child.arguments) {
    const parentArgs = parent.arguments && typeof parent.arguments === 'object' ? parent.arguments : {};
    const childArgs = child.arguments && typeof child.arguments === 'object' ? child.arguments : {};
    merged.arguments = {
      game: [
        ...(Array.isArray(parentArgs.game) ? parentArgs.game : []),
        ...(Array.isArray(childArgs.game) ? childArgs.game : []),
      ],
      jvm: [
        ...(Array.isArray(parentArgs.jvm) ? parentArgs.jvm : []),
        ...(Array.isArray(childArgs.jvm) ? childArgs.jvm : []),
      ],
    };
  }
  merged.inheritsFrom = child.inheritsFrom;
  return merged;
}

/** 读取本地缓存的原始 version json（若存在） */
function localVersionJsonPath(id: string): string {
  return path.join(versionsDir(), id, `${id}.json`);
}

export async function fetchVersionJson(entry: VersionManifestEntry, source: DownloadSource, customMirror?: string): Promise<Record<string, any>> {
  if (!isSafePathSegment(entry.id)) throw new Error(`版本 id 非法：${String(entry.id)}`);
  const local = localVersionJsonPath(entry.id);
  if (fs.existsSync(local)) {
    const cached = readJson<Record<string, any> | null>(local, null);
    if (cached) return cached;
  }
  const url = resolveSourceUrl(entry.url, source, customMirror);
  const json = await fetchJson<Record<string, any>>(url, { timeoutMs: 45000 });
  fs.mkdirSync(path.dirname(local), { recursive: true });
  writeJson(local, json);
  return json;
}

/** 完整解析（含递归 inheritsFrom） */
export async function resolveVersion(entry: VersionManifestEntry, source: DownloadSource, customMirror?: string, depth = 0): Promise<Record<string, any>> {
  if (depth > 5) throw new Error('inheritsFrom 嵌套过深');
  const raw = await fetchVersionJson(entry, source, customMirror);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`版本 JSON 格式不正确：${entry.id}`);
  if (raw.inheritsFrom) {
    if (typeof raw.inheritsFrom !== 'string') throw new Error(`版本 JSON 的 inheritsFrom 字段非法：${entry.id}`);
    const parentEntry = await findManifestEntry(raw.inheritsFrom, source, customMirror);
    const parent = await resolveVersion(parentEntry, source, customMirror, depth + 1);
    return mergeVersionJson(raw, parent);
  }
  return raw;
}

async function findManifestEntry(id: string, source: DownloadSource, customMirror?: string): Promise<VersionManifestEntry> {
  const manifest = await getVersionManifest(source, customMirror);
  const hit = manifest.versions.find(v => v.id === id);
  if (!hit) throw new Error(`清单中找不到版本：${id}`);
  if (!isSafePathSegment(hit.id)) throw new Error(`版本清单包含非法版本 id：${String(hit.id)}`);
  return hit;
}

/* ---------- 库与 natives ---------- */

/** 版本 id / 索引 id 会直接拼进数据目录，不能是 . / .. 或带路径分隔符 */
function isSafePathSegment(id: unknown): id is string {
  return typeof id === 'string'
    && id.length > 0 && id.length <= 128
    && /^[0-9A-Za-z_\-[\]]+(\.[0-9A-Za-z_\-[\]]+)*$/.test(id);
}

/** 版本元数据/资源索引是远程内容：entry.path 可能是 ../../ 或绝对路径 */
function isSafeRelativePath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || !rel || rel.length > 1024) return false;
  const norm = rel.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return false;
  return norm.split('/').every(seg => !!seg && seg !== '.' && seg !== '..');
}

const assertSafeRelPath = (rel: string, what: string): string => {
  if (!isSafeRelativePath(rel)) throw new Error(`${what}包含非法文件路径：${rel}`);
  return rel.replace(/\\/g, '/');
};

const mavenToPath = (name: string): string => {
  // Maven 坐标可能带 @扩展名（如 group:artifact:version@zip），@ 必须在拆坐标前剥离
  const at = name.indexOf('@');
  const extRaw = at >= 0 ? name.slice(at + 1) : 'jar';
  if (!/^[A-Za-z0-9.]+$/.test(extRaw)) throw new Error(`非法 maven 扩展名：${name}`);
  const ext = extRaw;
  const parts = (at >= 0 ? name.slice(0, at) : name).split(':');
  if (parts.length < 3) throw new Error(`非法 maven 坐标：${name}`);
  const [group, artifact, version, ...rest] = parts;
  const classifier = rest.length > 0 && rest[0] && !rest[0].startsWith('@') ? rest[0] : null;
  const groupPath = group.replace(/\./g, '/');
  const file = classifier ? `${artifact}-${version}-${classifier}.${ext}` : `${artifact}-${version}.${ext}`;
  return assertSafeRelPath(path.join(groupPath, artifact, version, file).replace(/\\/g, '/'), 'maven 坐标');
};

function osNativeKey(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const arch = process.arch === 'x64' ? '64' : process.arch === 'arm64' ? 'arm64' : '32';
  return `natives-${os}${arch === '64' ? '' : '-' + arch}`;
}

export function collectLibraries(resolved: Record<string, any>): LibraryDownload[] {
  const out: LibraryDownload[] = [];
  const libraries = Array.isArray(resolved.libraries) ? resolved.libraries : [];
  for (const lib of libraries) {
    if (!lib || typeof lib !== 'object') continue;
    if (lib.rules && !evalRules(lib.rules)) continue;
    const name: string = typeof lib.name === 'string' ? lib.name : '';
    if (!name) throw new Error('版本元数据里有一个库缺少 maven 坐标（name），文件可能已损坏，请删除该版本缓存后重试');
    // artifact 主体
    const artifact = lib.downloads?.artifact;
    if (artifact) {
      const rel = assertSafeRelPath((artifact.path as string | undefined) ?? mavenToPath(name), '库文件');
      out.push({
        name,
        url: artifact.url ?? `${OFFICIAL.libraries}/${rel}`,
        path: rel,
        sha1: artifact.sha1,
        size: artifact.size,
        isNative: false,
      });
    } else if (lib.url) {
      // 旧版 json：url 为 repo base
      const rel = mavenToPath(name);
      out.push({ name, url: `${String(lib.url).replace(/\/+$/, '')}/${rel}`, path: rel, isNative: false });
    } else {
      const rel = mavenToPath(name);
      out.push({ name, url: `${OFFICIAL.libraries}/${rel}`, path: rel, isNative: false });
    }
    // natives
    const classifiers = lib.downloads?.classifiers ?? {};
    const wanted = osNativeKey();
    const nativeEntry = classifiers[wanted] ?? classifiers[`natives-${process.platform === 'win32' ? 'windows' : 'linux'}`];
    if (nativeEntry) {
      const rel = assertSafeRelPath((nativeEntry.path as string | undefined) ?? mavenToPath(name), 'natives 文件');
      out.push({
        name,
        url: nativeEntry.url ?? `${OFFICIAL.libraries}/${rel}`,
        path: rel,
        sha1: nativeEntry.sha1,
        size: nativeEntry.size,
        isNative: true,
        nativeKey: wanted,
      });
    } else if (lib.natives) {
      // 旧版 json（如 1.7.10）：只有 natives 映射，没有 downloads.classifiers，
      // 需要按 maven classifier 自行拼出 natives jar，否则游戏会缺 lwjgl dll 直接崩。
      const osKey = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
      const classifier = lib.natives[osKey];
      if (typeof classifier === 'string' && classifier) {
        const rel = mavenToPath(`${name}:${classifier}`);
        const base = typeof lib.url === 'string' && lib.url
          ? String(lib.url).replace(/\/+$/, '')
          : OFFICIAL.libraries;
        out.push({ name, url: `${base}/${rel}`, path: rel, isNative: true, nativeKey: wanted });
      }
    }
  }
  return out;
}

/* ---------- 资源索引 ---------- */
export async function fetchAssetIndex(resolved: Record<string, any>, source: DownloadSource, customMirror?: string): Promise<{
  indexId: string;
  objects: AssetObject[];
}> {
  const ai = resolved.assetIndex ?? resolved.assets;
  if (typeof ai === 'string' || !ai || typeof ai !== 'object' || typeof ai.url !== 'string') {
    // 旧版：assetIndex 字段是名字，需要自行从 launchermeta 拿？兜底：按名字走缓存或报错
    const indexId = typeof ai === 'string' ? ai : ai?.id;
    if (!isSafePathSegment(indexId)) throw new Error(`资源索引 id 非法：${String(indexId)}`);
    const localIndex = path.join(assetsIndexDir(), `${indexId}.json`);
    if (fs.existsSync(localIndex)) {
      const cached = readJson(localIndex, { objects: {} as Record<string, { hash: string; size: number }> });
      return { indexId, objects: mapAssets(cached) };
    }
    throw new Error(`该版本使用旧式资源索引（${indexId}），首次导入请连接网络`);
  }
  if (!isSafePathSegment(ai.id)) throw new Error(`资源索引 id 非法：${String(ai.id)}`);
  const url = resolveSourceUrl(ai.url, source, customMirror);
  const fallbackUrl = ai.url; // 官方源兜底
  let indexJson: { objects: Record<string, { hash: string; size: number }> } | null = null;
  let lastError: unknown = null;
  for (const candidate of [url, fallbackUrl]) {
    try {
      indexJson = await fetchJson(candidate, { timeoutMs: 30000 });
      break;
    } catch (e) {
      lastError = e;
    }
  }
  if (!indexJson) {
    throw new Error(`资源索引下载失败（镜像与官方源均失败）：${lastError instanceof Error ? lastError.message : lastError}`);
  }
  try {
    fs.mkdirSync(assetsIndexDir(), { recursive: true });
    writeJson(path.join(assetsIndexDir(), `${ai.id}.json`), indexJson);
  } catch { /* ignore */ }
  return { indexId: ai.id, objects: mapAssets(indexJson) };
}

function mapAssets(indexJson: { objects?: Record<string, { hash: string; size: number }> }): AssetObject[] {
  return Object.entries(indexJson.objects ?? {}).map(([name, obj]) => {
    // 资源索引来自远程：hash 会拼进 cache 路径，必须是 40 位 SHA-1
    if (!obj || typeof obj.hash !== 'string' || !/^[a-f0-9]{40}$/i.test(obj.hash)) {
      throw new Error(`资源索引包含非法 hash（${name}），已停止下载以免写错目录`);
    }
    return { hash: obj.hash.toLowerCase(), size: Number.isFinite(obj.size) ? obj.size : 0, name };
  });
}

export function assetDestPath(hash: string): string {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw new Error('资源 hash 格式不正确');
  const sub = hash.slice(0, 2);
  return path.join(assetsObjectsDir(), sub, hash);
}

/** 构造完整的下载计划（库 + 资源 + 客户端 jar） */
export interface DownloadPlan {
  tasks: Array<{ id: string; url: string; sha1?: string; size?: number; dest: string; name: string }>;
  resolved: Record<string, any>;
  assetIndexId: string;
}

export async function buildDownloadPlan(entry: VersionManifestEntry, source: DownloadSource, customMirror?: string, includeAssets = true): Promise<DownloadPlan> {
  const resolved = await resolveVersion(entry, source, customMirror);
  const tasks: DownloadPlan['tasks'] = [];
  // 同一目标文件只允许一个任务：旧版资源索引里多个虚拟资源会共用同一个 objects/<hash> 文件，
  // 库也可能在 inheritsFrom 合并后重复出现。重复任务会并发写同一个 .part，把文件写坏。
  const seenDest = new Set<string>();
  const pushTask = (task: DownloadPlan['tasks'][number]): void => {
    const key = process.platform === 'win32' ? task.dest.toLowerCase() : task.dest;
    if (seenDest.has(key)) return;
    seenDest.add(key);
    tasks.push(task);
  };

  // 客户端 jar（旧版 jar 也走 downloads.client）
  const client = resolved.downloads?.client;
  if (client) {
    pushTask({
      id: `client:${entry.id}`,
      url: client.url,
      sha1: client.sha1,
      size: client.size,
      dest: path.join(versionsDir(), entry.id, `${entry.id}.jar`),
      name: `${entry.id} 客户端`,
    });
  }
  // 库
  for (const lib of collectLibraries(resolved)) {
    pushTask({
      id: `lib:${lib.path}`,
      url: lib.url,
      sha1: lib.sha1,
      size: lib.size,
      dest: path.join(librariesDir(), ...lib.path.split('/')),
      name: lib.isNative ? `natives ${path.basename(lib.path)}` : path.basename(lib.path),
    });
  }
  // 资源
  let assetIndexId = resolved.assets ?? 'legacy';
  if (includeAssets) {
    const { indexId, objects } = await fetchAssetIndex(resolved, source, customMirror);
    assetIndexId = indexId;
    for (const obj of objects) {
      const hash = obj.hash;
      pushTask({
        id: `asset:${hash}`,
        url: `https://resources.download.minecraft.net/${hash.slice(0, 2)}/${hash}`,
        sha1: hash,
        size: obj.size,
        dest: assetDestPath(hash),
        name: `资源 ${path.basename(obj.name)}`,
      });
    }
  }
  return { tasks, resolved, assetIndexId };
}
