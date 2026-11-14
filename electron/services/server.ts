/**
 * Minecraft 服务端管理：创建、安装、启停、控制台、server.properties、世界备份
 *
 * 设计：
 * - 每个服务器独立目录 <root>/servers/<id>/，互不影响
 * - 原版 / Fabric / Quilt / Forge / NeoForge 五种服务端
 * - 零第三方依赖：安装器调用官方 Java 安装器，进程用 child_process 管理
 * - 启动前自动准备 Java（复用 java.ts 的版本匹配与 Adoptium 下载）
 */
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as crypto from 'crypto';
import { spawn, execFile, execFileSync, ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import * as paths from './paths';
import { readJson, writeJson } from './store';
import { getSettings } from './settings';
import { proxyJvmArgs } from './proxy';
import * as javaService from './java';
import * as versionService from './version';
import { DownloadManager } from './downloader';
import { fetchJson, fetchWithTimeout } from './net';
import { zipFromDir, zipExtractAll } from './zip';
import {
  ServerBackupInfo, ServerConfig, ServerInfo, ServerLoader, ServerProperties, ServerStatus,
} from '../shared/types';

export const serverEvents = new EventEmitter();

interface Runtime {
  child: ChildProcessWithoutNullStreams | null;
  status: ServerStatus;
  startedAt: number | null;
  players: Set<string>;
  logTail: string[];
  stopping: boolean;
}

const runtimes = new Map<string, Runtime>();

const runtimeOf = (id: string): Runtime => {
  let rt = runtimes.get(id);
  if (!rt) {
    rt = { child: null, status: 'stopped', startedAt: null, players: new Set(), logTail: [], stopping: false };
    runtimes.set(id, rt);
  }
  return rt;
};

const newId = () => crypto.randomBytes(8).toString('hex');

function walkBytes(dir: string): number {
  let total = 0;
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else { try { total += fs.statSync(full).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return total;
}

function tailFile(file: string, maxLines = 200): string[] {
  try {
    if (!fs.existsSync(file)) return [];
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - 256 * 1024);
    const buf = Buffer.alloc(stat.size - start);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

/* ============================== 基础 CRUD ============================== */

export function listServers(): ServerInfo[] {
  const root = paths.serversDir();
  if (!fs.existsSync(root)) return [];
  const out: ServerInfo[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfg = readJson<ServerConfig | null>(paths.serverFile(entry.name), null);
    if (cfg) out.push(toInfo(cfg));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getServer(id: string): ServerInfo | null {
  const cfg = readJson<ServerConfig | null>(paths.serverFile(id), null);
  return cfg ? toInfo(cfg) : null;
}

function readConfig(id: string): ServerConfig {
  const cfg = readJson<ServerConfig | null>(paths.serverFile(id), null);
  if (!cfg) throw new Error('服务器不存在');
  return cfg;
}

function toInfo(cfg: ServerConfig): ServerInfo {
  const rt = runtimeOf(cfg.id);
  const logFile = path.join(paths.serverDir(cfg.id), 'logs', 'latest.log');
  const logTail = rt.logTail.length > 0 ? rt.logTail.slice(-200) : tailFile(logFile);
  return {
    ...cfg,
    dir: paths.serverDir(cfg.id),
    status: rt.status,
    pid: rt.child?.pid ?? null,
    startedAt: rt.startedAt,
    players: [...rt.players],
    online: rt.status === 'running',
    diskBytes: walkBytes(paths.serverDir(cfg.id)),
    logTail,
  };
}

export function createServer(input: {
  name: string;
  mcVersion: string;
  loader: ServerLoader;
  loaderVersion?: string | null;
  port?: number;
  memoryMB?: number;
  javaPath?: string | null;
}): ServerConfig {
  if (!/^[0-9A-Za-z_\-.[\]]+$/.test(input.mcVersion)) throw new Error('Minecraft 版本号格式不正确');
  const port = input.port ?? 25565;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1–65535 之间的整数');
  const memoryMB = Math.max(512, Math.min(32768, input.memoryMB ?? 2048));
  const id = newId();
  const cfg: ServerConfig = {
    id,
    name: input.name.trim() || `${input.mcVersion} 服务器`,
    mcVersion: input.mcVersion,
    loader: input.loader,
    loaderVersion: input.loaderVersion ?? null,
    port,
    memoryMB,
    javaPath: input.javaPath ?? null,
    jvmArgsExtra: '',
    eulaAccepted: false,
    prepared: false,
    createdAt: Date.now(),
    lastStartedAt: null,
  };
  fs.mkdirSync(paths.serverDir(id), { recursive: true });
  writeJson(paths.serverFile(id), cfg);
  writeDefaultProperties(id, port);
  return cfg;
}

export function updateServer(id: string, patch: Partial<ServerConfig>): ServerConfig {
  const current = readConfig(id);
  const next: ServerConfig = {
    ...current,
    ...patch,
    id: current.id,
    createdAt: current.createdAt,
  };
  if (next.port < 1 || next.port > 65535) throw new Error('端口必须是 1–65535 之间的整数');
  next.memoryMB = Math.max(512, Math.min(32768, next.memoryMB));
  writeJson(paths.serverFile(id), next);
  serverEvents.emit('status', toInfo(next));
  return next;
}

export async function deleteServer(id: string, backup = true): Promise<{ ok: boolean; backupPath?: string }> {
  const cfg = readConfig(id);
  await killServer(id).catch(() => undefined);
  const dir = paths.serverDir(id);
  if (!fs.existsSync(dir)) return { ok: false };
  let backupPath: string | undefined;
  if (backup) {
    const destDir = path.join(paths.backupsDir(), 'deleted-servers');
    fs.mkdirSync(destDir, { recursive: true });
    backupPath = path.join(destDir, `${cfg.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}-${Date.now()}.zip`);
    try { fs.writeFileSync(backupPath, zipFromDir(dir)); } catch { backupPath = undefined; }
  }
  runtimes.delete(id);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, backupPath };
}

/* ============================== server.properties ============================== */

const DEFAULT_PROPERTIES: Record<string, string> = {
  'server-port': '25565',
  'motd': 'MCL 服务器',
  'max-players': '20',
  'online-mode': 'true',
  'difficulty': 'easy',
  'gamemode': 'survival',
  'view-distance': '10',
  'simulation-distance': '10',
  'pvp': 'true',
  'white-list': 'false',
  'enforce-whitelist': 'false',
  'enable-command-block': 'false',
  'allow-flight': 'false',
  'spawn-protection': '16',
  'level-name': 'world',
  'level-seed': '',
  'enable-status': 'true',
  'enforce-secure-profile': 'true',
  'sync-chunk-writes': 'true',
  'allow-nether': 'true',
  'generate-structures': 'true',
  'spawn-monsters': 'true',
  'spawn-animals': 'true',
  'spawn-npcs': 'true',
  'function-permission-level': '2',
  'op-permission-level': '4',
  'player-idle-timeout': '0',
  'rate-limit': '0',
};

function writeDefaultProperties(id: string, port: number): void {
  const file = path.join(paths.serverDir(id), 'server.properties');
  if (fs.existsSync(file)) return;
  const lines = ['#Minecraft server properties', '#Generated by MCL'];
  const props = { ...DEFAULT_PROPERTIES, 'server-port': String(port) };
  for (const [k, v] of Object.entries(props)) lines.push(`${k}=${v}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

export function readServerProperties(id: string): ServerProperties {
  const file = path.join(paths.serverDir(id), 'server.properties');
  const out: ServerProperties = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/** 更新 server.properties：保留注释与未知键，只改传入的键 */
export function saveServerProperties(id: string, patch: ServerProperties): ServerProperties {
  const file = path.join(paths.serverDir(id), 'server.properties');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(patch));
  const out = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return line;
    const key = trimmed.slice(0, trimmed.indexOf('=')).trim();
    if (remaining.has(key)) {
      const value = remaining.get(key)!;
      remaining.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  for (const [k, v] of remaining) out.push(`${k}=${v}`);
  fs.writeFileSync(file, `${out.filter((l, i) => l !== '' || i < out.length - 1).join('\n')}\n`, 'utf8');
  return readServerProperties(id);
}

/* ============================== Java / 下载 ============================== */

async function resolveJava(cfg: ServerConfig): Promise<string> {
  const settings = getSettings();
  const wanted = cfg.javaPath ?? settings.java.defaultPath ?? null;
  let pick = await javaService.pickJavaFor(cfg.mcVersion, wanted);
  if (!pick.java) {
    const exe = await javaService.installJava(pick.recommendedMajor);
    pick = await javaService.pickJavaFor(cfg.mcVersion, exe);
  }
  if (!pick.java) throw new Error(`无法准备 Java ${pick.recommendedMajor}（自动下载失败），请检查网络或在设置中手动指定 Java。`);
  return pick.java.path;
}

async function mavenVersions(url: string): Promise<string[]> {
  const res = await fetchWithTimeout(url, { timeoutMs: 20000 });
  if (res.status >= 400) throw new Error(`Maven 元数据不可用（HTTP ${res.status}）`);
  return Array.from(res.body.toString('utf8').matchAll(/<version>([^<]+)<\/version>/g)).map(m => m[1].trim());
}

async function downloadFile(url: string, dest: string, name: string, sha1?: string): Promise<void> {
  const settings = getSettings();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const dl = new DownloadManager({
    source: settings.download.source,
    customMirror: settings.download.customMirror,
    maxThreads: 1,
    retries: settings.download.retries,
    timeoutMs: settings.download.timeoutMs,
  });
  const reports = await dl.run([{ id: `server:${name}:${dest}`, url, dest, sha1, name }]);
  if (!reports[0]?.ok) throw new Error(`${name} 下载失败：${reports[0]?.error ?? '未知错误'}\nURL：${url}`);
}

async function latestFabricLoader(mcVersion: string): Promise<string> {
  const list = await fetchJson<Array<{ loader: { version: string } }>>(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`, { timeoutMs: 20000 });
  if (!list?.length) throw new Error(`Fabric 不支持 Minecraft ${mcVersion}`);
  return list[0].loader.version;
}

async function latestQuiltLoader(mcVersion: string): Promise<string> {
  const list = await fetchJson<Array<{ loader: { version: string } }>>(`https://meta.quiltmc.org/v3/versions/loader/${mcVersion}`, { timeoutMs: 20000 });
  if (!list?.length) throw new Error(`Quilt 不支持 Minecraft ${mcVersion}`);
  return list[0].loader.version;
}

function neoForgePrefix(mcVersion: string): string {
  // NeoForge 1.20.1 沿用 Forge 的 47.x 版本号，其余版本从 MC 版本推导（1.21.4 → 21.4.）
  if (mcVersion === '1.20.1') return '47.';
  return mcVersion.replace(/^1\./, '').replace(/\.0$/, '') + '.';
}

function findInstalledJar(dir: string): string | null {
  for (const candidate of ['server.jar', 'quilt-server-launch.jar', 'fabric-server-launch.jar']) {
    const p = path.join(dir, candidate);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findForgeArgs(dir: string, loader: 'forge' | 'neoforge'): string | null {
  const base = path.join(dir, 'libraries', 'net', loader === 'forge' ? 'minecraftforge' : 'neoforged');
  if (!fs.existsSync(base)) return null;
  const wanted = process.platform === 'win32' ? 'win_args.txt' : 'unix_args.txt';
  const stack = [base];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === wanted) return full;
    }
  }
  return null;
}

function emitLog(id: string, line: string, source: 'install' | 'server' = 'server'): void {
  const rt = runtimeOf(id);
  const formatted = source === 'install' ? `[install] ${line}` : line;
  rt.logTail.push(formatted);
  if (rt.logTail.length > 800) rt.logTail.splice(0, rt.logTail.length - 800);
  serverEvents.emit('log', { serverId: id, line: formatted });
}

function setStatus(id: string, status: ServerStatus): void {
  const cfg = readJson<ServerConfig | null>(paths.serverFile(id), null);
  if (!cfg) return;
  runtimeOf(id).status = status;
  serverEvents.emit('status', toInfo(cfg));
}

/* ============================== 安装 / 准备 ============================== */

export async function prepareServer(id: string): Promise<ServerInfo> {
  const cfg = readConfig(id);
  const dir = paths.serverDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const rt = runtimeOf(id);
  if (rt.status === 'running' || rt.status === 'starting') throw new Error('服务器正在运行，无法重新安装');
  setStatus(id, 'preparing');
  try {
    const javaPath = await resolveJava(cfg);
    if (cfg.eulaAccepted) writeEula(id);
    writeDefaultProperties(id, cfg.port);

    if (cfg.loader === 'vanilla') {
      const settings = getSettings();
      const manifest = await versionService.getVersionManifest(settings.download.source, settings.download.customMirror);
      const entry = manifest.versions.find(v => v.id === cfg.mcVersion);
      if (!entry) throw new Error(`版本清单中找不到 ${cfg.mcVersion}`);
      const resolved = await versionService.resolveVersion(entry, settings.download.source, settings.download.customMirror);
      const server = resolved.downloads?.server;
      if (!server?.url) throw new Error(`Minecraft ${cfg.mcVersion} 没有可用的服务端下载（该版本可能不提供独立服务端）。`);
      emitLog(id, `正在下载原版服务端 ${cfg.mcVersion}…`, 'install');
      await downloadFile(server.url, path.join(dir, 'server.jar'), 'server.jar', server.sha1);
    } else if (cfg.loader === 'fabric') {
      const lv = cfg.loaderVersion || await latestFabricLoader(cfg.mcVersion);
      if (!cfg.loaderVersion) updateServer(id, { loaderVersion: lv });
      const url = `https://meta.fabricmc.net/v2/versions/loader/${cfg.mcVersion}/${lv}/server/jar`;
      emitLog(id, `正在下载 Fabric 服务端 ${cfg.mcVersion} / loader ${lv}…`, 'install');
      await downloadFile(url, path.join(dir, 'server.jar'), 'Fabric server.jar');
    } else if (cfg.loader === 'quilt') {
      const lv = cfg.loaderVersion || await latestQuiltLoader(cfg.mcVersion);
      if (!cfg.loaderVersion) updateServer(id, { loaderVersion: lv });
      const versions = await mavenVersions('https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/maven-metadata.xml');
      const installerVersion = versions[versions.length - 1];
      if (!installerVersion) throw new Error('无法确定 Quilt 安装器版本');
      const installerUrl = `https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/${installerVersion}/quilt-installer-${installerVersion}.jar`;
      const installerPath = path.join(dir, '.quilt-installer.jar');
      emitLog(id, `正在下载 Quilt 安装器 ${installerVersion}…`, 'install');
      await downloadFile(installerUrl, installerPath, 'Quilt 安装器');
      emitLog(id, '正在安装 Quilt 服务端（可能需要 1–3 分钟）…', 'install');
      await runInstaller(javaPath, ['-jar', installerPath, 'install', 'server', cfg.mcVersion, lv, `--install-dir=${dir}`, '--download-server'], dir, line => emitLog(id, line, 'install'));
      fs.rmSync(installerPath, { force: true });
      if (!findInstalledJar(dir)) throw new Error('Quilt 安装完成但找不到服务端启动 jar。');
    } else {
      const loader = cfg.loader;
      let forgeId = cfg.loaderVersion ?? '';
      let installerUrl: string;
      if (loader === 'forge') {
        if (!forgeId) {
          const versions = await mavenVersions('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
          const matching = versions.filter(v => v.startsWith(`${cfg.mcVersion}-`));
          if (!matching.length) throw new Error(`找不到适用于 ${cfg.mcVersion} 的 Forge 版本，请手动指定加载器版本。`);
          forgeId = matching[matching.length - 1];
        }
        const fullId = forgeId.includes('-') ? forgeId : `${cfg.mcVersion}-${forgeId}`;
        installerUrl = `https://maven.minecraftforge.net/net/minecraftforge/forge/${fullId}/forge-${fullId}-installer.jar`;
      } else {
        // NeoForge 1.20.1 沿用 Forge 47.x，发布坐标为 net.neoforged:forge，版本带 1.20.1- 前缀
        const neoForgeLegacy = cfg.mcVersion === '1.20.1';
        if (!forgeId) {
          const metaUrl = neoForgeLegacy
            ? 'https://maven.neoforged.net/releases/net/neoforged/forge/maven-metadata.xml'
            : 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
          const versions = await mavenVersions(metaUrl);
          const prefix = neoForgePrefix(cfg.mcVersion);
          const matching = versions.filter(v => v.startsWith(prefix));
          if (!matching.length) throw new Error(`找不到适用于 ${cfg.mcVersion} 的 NeoForge 版本，请手动指定加载器版本。`);
          forgeId = matching[matching.length - 1];
        }
        if (neoForgeLegacy) {
          forgeId = forgeId.startsWith(`${cfg.mcVersion}-`) ? forgeId : `${cfg.mcVersion}-${forgeId}`;
          installerUrl = `https://maven.neoforged.net/releases/net/neoforged/forge/${forgeId}/forge-${forgeId}-installer.jar`;
        } else {
          installerUrl = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${forgeId}/neoforge-${forgeId}-installer.jar`;
        }
      }
      if (!cfg.loaderVersion) updateServer(id, { loaderVersion: forgeId });
      const installerPath = path.join(dir, `.${loader}-installer.jar`);
      emitLog(id, `正在下载 ${loader === 'forge' ? 'Forge' : 'NeoForge'} 安装器（${forgeId}）…`, 'install');
      await downloadFile(installerUrl, installerPath, `${loader} 安装器`);
      emitLog(id, '正在静默安装服务端（可能需要 1–5 分钟）…', 'install');
      await runInstaller(javaPath, ['-jar', installerPath, '--installServer', dir], dir, line => emitLog(id, line, 'install'));
      fs.rmSync(installerPath, { force: true });
      if (!findForgeArgs(dir, loader)) throw new Error(`${loader} 安装完成但找不到启动参数文件，请查看安装日志。`);
    }

    updateServer(id, { prepared: true, eulaAccepted: cfg.eulaAccepted });
    emitLog(id, '服务端安装完成。', 'install');
    setStatus(id, 'stopped');
    return getServer(id)!;
  } catch (e) {
    setStatus(id, 'stopped');
    throw e;
  }
}

function runInstaller(javaPath: string, args: string[], cwd: string, onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true });
    child.stdout.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(onLine));
    child.stderr.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(onLine));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`安装器退出码 ${code}，请查看上面的安装日志。`)));
  });
}

function writeEula(id: string): void {
  fs.writeFileSync(path.join(paths.serverDir(id), 'eula.txt'), '#By changing the setting below to TRUE you are indicating your agreement to our EULA (https://aka.ms/MinecraftEULA).\neula=true\n', 'utf8');
}

export function acceptEula(id: string): ServerConfig {
  const cfg = updateServer(id, { eulaAccepted: true });
  writeEula(id);
  return cfg;
}

/* ============================== 启动 / 停止 ============================== */

function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '0.0.0.0');
  });
}

export function isPortAvailable(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return portAvailable(port);
}

/** 退出启动器时强制结束所有服务端进程（同步，避免 Electron 先退出留下孤儿 Java） */
export function killAllServersSync(): void {
  for (const rt of runtimes.values()) {
    const pid = rt.child?.pid;
    if (!pid) continue;
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
      } else {
        rt.child!.kill('SIGKILL');
      }
    } catch { /* 进程已退出 */ }
    rt.child = null;
    rt.status = 'stopped';
  }
}

function jvmArgsFor(cfg: ServerConfig): string[] {
  const settings = getSettings();
  const min = Math.max(256, Math.floor(cfg.memoryMB / 2));
  const args = [`-Xms${min}M`, `-Xmx${cfg.memoryMB}M`];
  if (settings.launch.utf8Encoding) args.push('-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8');
  // 服务端也加 Log4j 缓解（老版本）
  if (settings.launch.log4jFix && /^1\.([0-9]|1[0-6])\./.test(cfg.mcVersion)) args.push('-Dlog4j2.formatMsgNoLookups=true');
  for (const piece of (settings.launch.globalJvmArgs || '').split(/\s+|\n+/).map(s => s.trim()).filter(Boolean)) args.push(piece);
  for (const piece of (cfg.jvmArgsExtra || '').split(/\s+|\n+/).map(s => s.trim()).filter(Boolean)) args.push(piece);
  for (const piece of proxyJvmArgs()) args.push(piece);
  return args;
}

export async function startServer(id: string): Promise<ServerInfo> {
  const cfg = readConfig(id);
  const rt = runtimeOf(id);
  if (rt.child || rt.status === 'running' || rt.status === 'starting') throw new Error('服务器已经在运行中');
  if (!cfg.eulaAccepted) throw new Error('请先阅读并同意 Minecraft 服务器 EULA（界面中勾选后再启动）。');
  const dir = paths.serverDir(id);
  if (!cfg.prepared) await prepareServer(id);
  const fresh = readConfig(id);

  const forgeLoader: 'forge' | 'neoforge' | null = fresh.loader === 'forge' || fresh.loader === 'neoforge' ? fresh.loader : null;
  if (!forgeLoader && !findInstalledJar(dir)) throw new Error('服务端文件不存在，请点击「重新安装」后再启动。');
  if (forgeLoader && !findForgeArgs(dir, forgeLoader)) throw new Error('Forge/NeoForge 启动参数缺失，请点击「重新安装」后再启动。');
  if (!(await portAvailable(fresh.port))) {
    throw new Error(`端口 ${fresh.port} 已被占用。请关闭占用该端口的程序，或在「服务器设置」里换一个端口。`);
  }

  const javaPath = await resolveJava(fresh);
  const args = jvmArgsFor(fresh);
  if (forgeLoader) {
    const userArgsFile = path.join(dir, 'user_jvm_args.txt');
    fs.writeFileSync(userArgsFile, `${args.join('\n')}\n`, 'utf8');
    const forgeArgs = findForgeArgs(dir, forgeLoader)!;
    args.push(`@${path.relative(dir, userArgsFile).replace(/\\/g, '/')}`, `@${path.relative(dir, forgeArgs).replace(/\\/g, '/')}`, 'nogui');
  } else {
    const jar = findInstalledJar(dir)!;
    args.push('-jar', path.basename(jar), 'nogui');
  }

  setStatus(id, 'starting');
  emitLog(id, `[mcl] 启动：${javaPath} ${args.slice(0, 5).join(' ')} …`);
  const child = spawn(javaPath, args, { cwd: dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  rt.child = child;
  rt.startedAt = Date.now();
  rt.stopping = false;
  rt.players.clear();
  updateServer(id, { lastStartedAt: rt.startedAt });

  const handleLines = (text: string) => {
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line.trim()) continue;
      emitLog(id, line);
      if (/Done \([\d.]+s\)! For help/.test(line)) setStatus(id, 'running');
      const join = line.match(/(?:^|\]: )([A-Za-z0-9_]{1,16}) joined the game/);
      if (join) {
        rt.players.add(join[1]);
        const current = readConfig(id);
        serverEvents.emit('status', toInfo(current));
      }
      const leave = line.match(/(?:^|\]: )([A-Za-z0-9_]{1,16}) left the game/);
      if (leave) {
        rt.players.delete(leave[1]);
        serverEvents.emit('status', toInfo(readConfig(id)));
      }
      if (/Stopping server/.test(line)) setStatus(id, 'stopping');
    }
  };
  child.stdout.on('data', handleLines);
  child.stderr.on('data', handleLines);
  child.on('error', err => {
    emitLog(id, `[mcl] 进程错误：${err.message}`);
    rt.status = 'crashed';
    rt.child = null;
    serverEvents.emit('status', toInfo(readConfig(id)));
  });
  child.on('close', code => {
    const intentional = rt.stopping || code === 0;
    emitLog(id, `[mcl] 服务器进程退出，退出码 ${code}`);
    rt.child = null;
    rt.startedAt = null;
    rt.players.clear();
    rt.status = intentional ? 'stopped' : 'crashed';
    rt.stopping = false;
    serverEvents.emit('status', toInfo(readConfig(id)));
  });
  return getServer(id)!;
}

export async function stopServer(id: string): Promise<boolean> {
  const rt = runtimeOf(id);
  if (!rt.child) return false;
  rt.stopping = true;
  setStatus(id, 'stopping');
  emitLog(id, '[mcl] 正在发送 stop 命令…');
  try { rt.child.stdin.write('stop\n'); } catch { /* ignore */ }
  const child = rt.child;
  const exited = await new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), 30000);
    child.once('close', () => { clearTimeout(timer); resolve(true); });
  });
  if (!exited) {
    emitLog(id, '[mcl] 服务器 30 秒内未退出，强制结束进程。');
    await killServer(id);
  }
  return true;
}

/** 强制结束服务端（含子进程树） */
export async function killServer(id: string): Promise<boolean> {
  const rt = runtimeOf(id);
  const child = rt.child;
  if (!child?.pid) return false;
  rt.stopping = true;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000, windowsHide: true }, () => resolve());
    });
  } else {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    await new Promise(r => setTimeout(r, 1500));
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  return true;
}

export function sendCommand(id: string, command: string): boolean {
  const rt = runtimeOf(id);
  if (!rt.child?.stdin.writable) throw new Error('服务器没有运行');
  rt.child.stdin.write(`${command.replace(/\r?\n/g, '')}\n`);
  emitLog(id, `> ${command}`);
  return true;
}

/* ============================== 世界备份 ============================== */

export function listServerBackups(id: string): ServerBackupInfo[] {
  const dir = paths.serverBackupsDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.zip')).map(f => {
    const p = path.join(dir, f);
    const stat = fs.statSync(p);
    return { name: f.replace(/\.zip$/, ''), filePath: p, sizeBytes: stat.size, createdAt: stat.mtimeMs };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

/** level-name 可被手动改成 ../xxx，必须校验解析后的世界目录仍在服务器目录内 */
function resolveServerWorldDir(id: string, worldName: string): string {
  const serverDir = path.resolve(paths.serverDir(id));
  const worldDir = path.resolve(serverDir, worldName);
  if (worldDir !== serverDir && !worldDir.startsWith(serverDir + path.sep)) {
    throw new Error(`level-name「${worldName}」指向了服务器目录之外，请先在服务器属性里改成正常的世界名。`);
  }
  if (worldDir === serverDir) throw new Error('level-name 不能是服务器根目录，请改成具体世界名。');
  return worldDir;
}

export function backupServerWorld(id: string, name?: string): ServerBackupInfo {
  readConfig(id);
  const props = readServerProperties(id);
  const worldName = props['level-name'] || 'world';
  const worldDir = resolveServerWorldDir(id, worldName);
  if (!fs.existsSync(worldDir)) throw new Error(`找不到世界目录：${worldName}`);
  const dir = paths.serverBackupsDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = (name ?? `world-${stamp}`).replace(/[^\w\u4e00-\u9fa5-]/g, '_');
  const filePath = path.join(dir, `${base}.zip`);
  fs.writeFileSync(filePath, zipFromDir(worldDir));
  return { name: base, filePath, sizeBytes: fs.statSync(filePath).size, createdAt: Date.now() };
}

export function restoreServerWorld(id: string, backupName: string): { restoredFiles: number } {
  const rt = runtimeOf(id);
  if (rt.child) throw new Error('请先停止服务器再恢复世界备份');
  readConfig(id);
  const props = readServerProperties(id);
  const worldName = props['level-name'] || 'world';
  const zipPath = path.join(paths.serverBackupsDir(id), `${path.basename(backupName)}.zip`);
  if (!fs.existsSync(zipPath)) throw new Error('备份文件不存在');
  const worldDir = resolveServerWorldDir(id, worldName);
  const files = zipExtractAll(fs.readFileSync(zipPath), worldDir);
  return { restoredFiles: files.length };
}

export function deleteServerBackup(id: string, backupName: string): void {
  const zipPath = path.join(paths.serverBackupsDir(id), `${path.basename(backupName)}.zip`);
  fs.rmSync(zipPath, { force: true });
}

/* ============================== 日志 ============================== */

export function readServerLog(id: string, maxLines = 400): string[] {
  const rt = runtimeOf(id);
  if (rt.logTail.length > 0) return rt.logTail.slice(-maxLines);
  return tailFile(path.join(paths.serverDir(id), 'logs', 'latest.log'), maxLines);
}