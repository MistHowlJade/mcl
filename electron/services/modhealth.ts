/**
 * 模组目录"体检"（痛点 #42：新旧版本混杂、重复 jar、缺失前置提示）
 * 直接解析 jar 内的模组元数据，不需要联网
 */
import * as fs from 'fs';
import * as path from 'path';
import { zipList, zipExtractEntry } from './zip';
import { ModHealthIssue } from '../shared/types';

interface ModMeta { id: string | null; version: string | null; loader: 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'unknown' }

function parseFabricJson(buf: Buffer): ModMeta {
  try {
    const json = JSON.parse(buf.toString('utf8'));
    return { id: json?.id ?? null, version: String(json?.version ?? ''), loader: 'fabric' };
  } catch { return { id: null, version: null, loader: 'fabric' }; }
}

function parseQuiltJson(buf: Buffer): ModMeta {
  try {
    const json = JSON.parse(buf.toString('utf8'));
    const loader = json?.quilt_loader ?? {};
    return { id: loader?.id ?? json?.id ?? null, version: String(loader?.version ?? json?.version ?? ''), loader: 'quilt' };
  } catch { return { id: null, version: null, loader: 'quilt' }; }
}

/** 极简 TOML 取值：mods.toml / neoforge.mods.toml 的 modId / version（首个 [mods] 段） */
function parseModsToml(buf: Buffer): ModMeta {
  const text = buf.toString('utf8');
  const modsIdx = text.search(/\[\[mods\]\]/i);
  const segment = modsIdx >= 0 ? text.slice(modsIdx) : text;
  const id = segment.match(/(?:^|\n)\s*modId\s*=\s*"([^"]+)"/i)?.[1] ?? null;
  let version = segment.match(/(?:^|\n)\s*version\s*=\s*"([^"$][^"]*)"/i)?.[1] ?? null;
  if (version && version.startsWith('${')) version = null;
  return { id, version, loader: /neoforge/i.test(text) ? 'neoforge' : 'forge' };
}

export function readJarModMeta(jarPath: string): ModMeta {
  try {
    const buf = fs.readFileSync(jarPath);
    const entries = zipList(buf);
    const find = (name: string) => entries.find(e => e.name.toLowerCase() === name.toLowerCase());
    const fabric = find('fabric.mod.json');
    if (fabric) return parseFabricJson(zipExtractEntry(buf, fabric));
    const quilt = find('quilt.mod.json');
    if (quilt) return parseQuiltJson(zipExtractEntry(buf, quilt));
    const nf = find('META-INF/neoforge.mods.toml');
    if (nf) return parseModsToml(zipExtractEntry(buf, nf));
    const mf = find('META-INF/mods.toml');
    if (mf) return parseModsToml(zipExtractEntry(buf, mf));
    return { id: null, version: null, loader: 'unknown' };
  } catch {
    return { id: null, version: null, loader: 'unknown' };
  }
}

export interface ModHealthReport {
  instanceId: string;
  scanned: number;
  issues: ModHealthIssue[];
}

export function checkModHealth(instanceId: string, gameDir: string, currentLoader?: string): ModHealthReport {
  const modsDir = path.join(gameDir, 'mods');
  const issues: ModHealthIssue[] = [];
  if (!fs.existsSync(modsDir)) return { instanceId, scanned: 0, issues };

  const jars = fs.readdirSync(modsDir).filter(f => f.endsWith('.jar'));
  const metas = jars.map(f => ({ fileName: f, path: path.join(modsDir, f), stat: fs.statSync(path.join(modsDir, f)), meta: readJarModMeta(path.join(modsDir, f)) }));

  // 1) 零字节文件
  for (const m of metas) {
    if (m.stat.size === 0) {
      issues.push({ kind: 'zero-byte', modName: m.fileName, detail: '文件大小为 0，下载中断或解压损坏，建议重新下载。', fix: { action: 'quarantine-file', target: m.fileName } });
    }
  }
  // 2) 同 id 重复（新旧混杂）
  const byId = new Map<string, typeof metas>();
  for (const m of metas) {
    if (!m.meta.id) continue;
    const list = byId.get(m.meta.id) ?? [];
    list.push(m);
    byId.set(m.meta.id, list);
  }
  for (const [id, group] of byId) {
    if (group.length <= 1) continue;
    // 保留修改时间最新的，其余隔离
    const sorted = [...group].sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const old of sorted.slice(1)) {
      issues.push({
        kind: 'duplicate',
        modName: `${id} × ${group.length}`,
        detail: `检测到重复模组：${group.map(g => g.fileName).join('、')}。新版通常应保留最新的一个。`,
        fix: { action: 'quarantine-oldest', target: old.fileName },
      });
    }
  }
  // 3) 异加载器模组放进了当前实例
  if (currentLoader && currentLoader !== 'vanilla') {
    for (const m of metas) {
      if (m.meta.loader === 'unknown' || m.meta.id === null) continue;
      if (currentLoader === 'forge' || currentLoader === 'neoforge') {
        if (m.meta.loader === 'fabric' || m.meta.loader === 'quilt') {
          issues.push({ kind: 'foreign-loader', modName: m.fileName, detail: `这是 ${m.meta.loader} 模组，而当前实例使用 Forge/NeoForge，它不会生效。`, fix: { action: 'quarantine-file', target: m.fileName } });
        }
      } else if (m.meta.loader === 'forge' || m.meta.loader === 'neoforge') {
        issues.push({ kind: 'foreign-loader', modName: m.fileName, detail: `这是 ${m.meta.loader} 模组，而当前实例使用 Fabric/Quilt，它不会生效。`, fix: { action: 'quarantine-file', target: m.fileName } });
      }
    }
  }
  return { instanceId, scanned: metas.length, issues };
}

/** 应用体检修复：把问题 jar 重命名为 .jar.disabled */
export function applyModHealthFix(instanceId: string, gameDir: string, target: string): boolean {
  const modsDir = path.resolve(gameDir, 'mods');
  // 只取文件名并做目录边界校验，防止 target 携带 ../ 逃逸 mods 目录
  const full = path.resolve(modsDir, path.basename(target));
  if (!full.startsWith(modsDir + path.sep)) return false;
  if (fs.existsSync(full) && full.endsWith('.jar')) {
    fs.renameSync(full, full + '.disabled');
    return true;
  }
  return false;
}
