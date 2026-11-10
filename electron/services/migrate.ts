/**
 * 从其它启动器迁移（痛点 #45/#46/#48）：扫描 HMCL / PCL2 / Prism / MultiMC / .minecraft
 * 只复制存档/模组/配置等"用户数据"，库与资源交给 MCL 的共享目录重新按需下载
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as paths from './paths';
import { createInstance } from './instances';
import { MigrationCandidate, MigrationPreview, MigrationResult, LoaderType } from '../shared/types';
import { getSettings } from './settings';

const roaming = () => process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');

export function detectCandidates(): MigrationCandidate[] {
  const candidates: MigrationCandidate[] = [
    { launcher: 'HMCL', path: path.join(roaming(), '.hmcl'), exists: false, hint: 'HMCL 默认数据目录（版本隔离时各版本在对应目录下）' },
    { launcher: 'PCL2 / 官方启动器（.minecraft）', path: path.join(roaming(), '.minecraft'), exists: false, hint: 'PCL2 默认数据目录（共享。含 versions/ 时为版本隔离）' },
    { launcher: 'Prism Launcher', path: path.join(roaming(), 'PrismLauncher'), exists: false, hint: 'Prism 默认数据目录（实例在 instances/ 下）' },
    { launcher: 'MultiMC', path: path.join(roaming(), 'MultiMC'), exists: false, hint: 'MultiMC 默认数据目录' },
    { launcher: 'ATLauncher', path: path.join(roaming(), 'ATLauncher'), exists: false, hint: 'ATLauncher 数据目录' },
    { launcher: 'PCL2 CE（自定义目录）', path: path.join(roaming(), 'PCL'), exists: false, hint: '若 PCL 使用独立数据目录也可手动选择' },
  ];
  for (const c of candidates) c.exists = fs.existsSync(c.path);
  return candidates;
}

interface FoundInstance { name: string; gameDir: string; mcVersion: string | null; loader: LoaderType; loaderVersion: string | null }

function looksLikeGameDir(dir: string): boolean {
  try {
    const names = fs.readdirSync(dir);
    return names.includes('saves') || names.includes('mods') || names.includes('version_manifest_v2.json') || names.includes('libraries');
  } catch { return false; }
}

/** 扫描数据根目录，找出所有"实例" */
function scanInstances(root: string): FoundInstance[] {
  const out: FoundInstance[] = [];
  const rootType = path.basename(root).toLowerCase();

  // Prism / MultiMC：instances/<名字>/.minecraft 或 instances/<名字>/minecraft
  const prismInstances = path.join(root, 'instances');
  if (fs.existsSync(prismInstances)) {
    for (const e of fs.readdirSync(prismInstances, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const instDir = path.join(prismInstances, e.name);
      const candidate = [path.join(instDir, '.minecraft'), path.join(instDir, 'minecraft')].find(looksLikeGameDir);
      if (candidate) {
        out.push({ name: e.name, gameDir: candidate, mcVersion: readPackVersion(instDir), loader: readPackLoader(instDir), loaderVersion: null });
      } else if (looksLikeGameDir(instDir)) {
        out.push({ name: e.name, gameDir: instDir, mcVersion: null, loader: 'vanilla', loaderVersion: null });
      }
    }
    return out;
  }

  // .minecraft 布局（PCL2/HMCL/官方）
  // 1) 版本隔离：versions/<版本名>/（存档直接在版本目录内）
  const versionsDir = path.join(root, 'versions');
  if (fs.existsSync(versionsDir)) {
    for (const e of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const vdir = path.join(versionsDir, e.name);
      if (looksLikeGameDir(vdir)) {
        const { mcVersion, loader, loaderVersion } = parseVersionName(e.name);
        out.push({ name: e.name, gameDir: vdir, mcVersion, loader, loaderVersion });
      }
    }
  }
  // 2) 根目录本身就是游戏目录（未开隔离）
  if (looksLikeGameDir(root) && fs.readdirSync(root).some(n => ['saves', 'mods', 'config'].includes(n))) {
    out.push({ name: rootType === '.minecraft' ? '.minecraft 默认实例' : path.basename(root), gameDir: root, mcVersion: detectMcVersionFromLibraries(root), loader: 'vanilla', loaderVersion: null });
  }
  return out;
}

/** Prism/MultiMC：从 mmc-pack.json 或 inplace 实例读版本 */
function readPackVersion(instDir: string): string | null {
  const pack = path.join(instDir, 'mmc-pack.json');
  try {
    if (fs.existsSync(pack)) {
      const json = JSON.parse(fs.readFileSync(pack, 'utf8'));
      const mc = (json?.components ?? []).find((c: any) => c?.uid === 'net.minecraft');
      return mc?.version ?? null;
    }
  } catch { /* ignore */ }
  return null;
}

function readPackLoader(instDir: string): LoaderType {
  try {
    if (fs.existsSync(path.join(instDir, 'mmc-pack.json'))) {
      const json = JSON.parse(fs.readFileSync(path.join(instDir, 'mmc-pack.json'), 'utf8'));
      const ids = (json?.components ?? []).map((c: any) => String(c?.uid ?? ''));
      if (ids.includes('net.fabricmc.fabric-loader')) return 'fabric';
      if (ids.includes('org.quiltmc.quilt-loader')) return 'quilt';
      if (ids.includes('net.minecraftforge')) return 'forge';
      if (ids.includes('net.neoforged')) return 'neoforge';
    }
  } catch { /* ignore */ }
  return 'vanilla';
}

/** 版本名里提取 MC 版本/加载器，如 "1.20.1-forge-47.2.0"、"fabric-loader-0.15.7-1.20.4" */
function parseVersionName(name: string): { mcVersion: string | null; loader: LoaderType; loaderVersion: string | null } {
  const mc = name.match(/(1\.\d+(?:\.\d+)?|\d+\.\d+(?:\.\d+)?)/);
  const loader: LoaderType = /neoforge/i.test(name) ? 'neoforge' : /forge/i.test(name) ? 'forge' : /fabric/i.test(name) ? 'fabric' : /quilt/i.test(name) ? 'quilt' : 'vanilla';
  const forgeMatch = name.match(/forge-([\d.]+)/i);
  const fabricMatch = name.match(/fabric-loader-([\d.]+)/i);
  const quiltMatch = name.match(/quilt-loader-([\d.]+)/i);
  const neoforgeMatch = name.match(/neoforge-([\d.]+)/i);
  const loaderVersion = forgeMatch?.[1] ?? fabricMatch?.[1] ?? quiltMatch?.[1] ?? neoforgeMatch?.[1] ?? null;
  return { mcVersion: mc ? mc[1] : null, loader, loaderVersion };
}

function detectMcVersionFromLibraries(root: string): string | null {
  const versions = path.join(root, 'versions');
  try {
    if (fs.existsSync(versions)) {
      const names = fs.readdirSync(versions).filter(n => /^(1\.\d+(\.\d+)?|\d+\.\d+)/.test(n));
      if (names.length) return names.sort().pop()!.match(/^(1\.\d+(\.\d+)?|\d+\.\d+)/)![1];
    }
  } catch { /* ignore */ }
  return null;
}

const COPY_DIRS = ['saves', 'mods', 'config', 'resourcepacks', 'shaderpacks', 'screenshots', 'xaero', 'journeymap', 'minimap', 'schematics'];
const COPY_FILES = ['options.txt', 'servers.dat', 'keybinds.txt', 'realms_persistence.json'];

export function previewMigration(root: string): MigrationPreview {
  const found = scanInstances(root);
  const instances = found.map(f => {
    let totalBytes = 0;
    let saves: string[] = [];
    let modsCount = 0;
    let configFiles = 0;
    try { saves = fs.existsSync(path.join(f.gameDir, 'saves')) ? fs.readdirSync(path.join(f.gameDir, 'saves')).filter(d => { try { return fs.statSync(path.join(f.gameDir, 'saves', d)).isDirectory(); } catch { return false; } }) : []; } catch { saves = []; }
    try { modsCount = fs.existsSync(path.join(f.gameDir, 'mods')) ? fs.readdirSync(path.join(f.gameDir, 'mods')).filter(n => n.endsWith('.jar')).length : 0; } catch { modsCount = 0; }
    const countDir = (dir: string): number => {
      let total = 0;
      const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const full = path.join(d, e.name); if (e.isDirectory()) walk(full); else { try { total += fs.statSync(full).size; } catch { /* skip */ } } } };
      try { walk(dir); } catch { /* skip */ }
      return total;
    };
    try { totalBytes = countDir(f.gameDir); } catch { totalBytes = 0; }
    try { configFiles = fs.existsSync(path.join(f.gameDir, 'config')) ? fs.readdirSync(path.join(f.gameDir, 'config')).length : 0; } catch { configFiles = 0; }
    return { name: f.name, mcVersion: f.mcVersion, loader: f.loader, loaderVersion: f.loaderVersion, saves, modsCount, configFiles, totalBytes };
  });
  return { path: root, instances };
}

export function importInstances(root: string, selectedNames?: string[]): MigrationResult {
  const found = scanInstances(root);
  const selected = selectedNames?.length ? found.filter(f => selectedNames.includes(f.name)) : found;
  const imported: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const copyInsteadOfMove = getSettings().migration.copyInsteadOfMove;

  for (const f of selected) {
    try {
      const cfg = createInstance({
        name: f.name.slice(0, 60),
        mcVersion: f.mcVersion ?? '1.20.1',
        loader: f.loader,
        loaderVersion: f.loaderVersion,
        memoryPreset: 'standard',
      });
      const dest = paths.gameDir(cfg.id);
      for (const dir of COPY_DIRS) {
        const src = path.join(f.gameDir, dir);
        if (fs.existsSync(src)) copyRecursive(src, path.join(dest, dir), copyInsteadOfMove);
      }
      for (const file of COPY_FILES) {
        const src = path.join(f.gameDir, file);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, file));
      }
      imported.push(f.name);
    } catch (e) {
      skipped.push({ name: f.name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { imported, skipped };
}

function copyRecursive(src: string, dest: string, copy: boolean): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyRecursive(s, d, copy);
    else {
      if (copy) fs.copyFileSync(s, d);
      else fs.renameSync(s, d);
    }
  }
}
