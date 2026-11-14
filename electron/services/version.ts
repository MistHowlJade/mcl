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
  if (cache && Date.now() - cache.at < 30 * 60 * 1000) return cache.manifest;
  const url = resolveSourceUrl(OFFICIAL.versionManifest, source, customMirror);
  const manifest = await fetchJson<VersionManifest>(url, { timeoutMs: 20000 });
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
      const want = rule.os.arch.toLowerCase();
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
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    const applies = evalRule(rule, features);
    if (applies) allowed = rule.action === 'allow';
  }
  return allowed;
}

/** 合并加载器 profile json（fabric/quilt/forge）到已解析的基础版本上 */
export function mergeProfile(base: Record<string, any>, profile: Record<string, any>): Record<string, any> {
  const merged = mergeVersionJson(profile, base);
  // profile 的 inheritsFrom 不应覆盖基础解析
  delete merged.inheritsFrom;
  return merged;
}

/* ---------- inheritsFrom 合并 ---------- */
function mergeVersionJson(child: Record<string, any>, parent: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = { ...parent, ...child };
  // libraries 拼接（父在前，子追加）
  merged.libraries = [...(parent.libraries ?? []), ...(child.libraries ?? [])];
  // arguments 合并
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...((parent.arguments?.game) ?? []), ...((child.arguments?.game) ?? [])],
      jvm: [...((parent.arguments?.jvm) ?? []), ...((child.arguments?.jvm) ?? [])],
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
  if (raw.inheritsFrom) {
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
  return hit;
}

/* ---------- 库与 natives ---------- */
const mavenToPath = (name: string): string => {
  const parts = name.split(':');
  if (parts.length < 3) throw new Error(`非法 maven 坐标：${name}`);
  const [group, artifact, version, ...rest] = parts;
  const ext = rest.length > 0 && rest[0].startsWith('@') ? rest[0].slice(1) : 'jar';
  const classifier = rest.length > 0 && !rest[0].startsWith('@') ? rest[0] : null;
  const groupPath = group.replace(/\./g, '/');
  const file = classifier ? `${artifact}-${version}-${classifier}.${ext}` : `${artifact}-${version}.${ext}`;
  return path.join(groupPath, artifact, version, file).replace(/\\/g, '/');
};

function osNativeKey(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const arch = process.arch === 'x64' ? '64' : process.arch === 'arm64' ? 'arm64' : '32';
  return `natives-${os}${arch === '64' ? '' : '-' + arch}`;
}

export function collectLibraries(resolved: Record<string, any>): LibraryDownload[] {
  const out: LibraryDownload[] = [];
  for (const lib of resolved.libraries ?? []) {
    if (lib.rules && !evalRules(lib.rules)) continue;
    const name: string = lib.name;
    // artifact 主体
    const artifact = lib.downloads?.artifact;
    if (artifact) {
      const rel = (artifact.path as string | undefined) ?? mavenToPath(name);
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
      const rel = (nativeEntry.path as string | undefined) ?? mavenToPath(name);
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
  if (typeof ai === 'string' || !ai.url) {
    // 旧版：assetIndex 字段是名字，需要自行从 launchermeta 拿？兜底：按名字走缓存或报错
    const indexId = typeof ai === 'string' ? ai : ai?.id;
    const localIndex = path.join(assetsIndexDir(), `${indexId}.json`);
    if (fs.existsSync(localIndex)) {
      const cached = readJson(localIndex, { objects: {} as Record<string, { hash: string; size: number }> });
      return { indexId, objects: mapAssets(cached) };
    }
    throw new Error(`该版本使用旧式资源索引（${indexId}），首次导入请连接网络`);
  }
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
  return Object.entries(indexJson.objects ?? {}).map(([name, obj]) => ({ hash: obj.hash, size: obj.size, name }));
}

export function assetDestPath(hash: string): string {
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

  // 客户端 jar（旧版 jar 也走 downloads.client）
  const client = resolved.downloads?.client;
  if (client) {
    tasks.push({
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
    tasks.push({
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
      tasks.push({
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
