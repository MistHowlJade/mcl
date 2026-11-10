/**
 * 极简原子 JSON 存储（无第三依赖，避免损坏半个文件）
 */
import * as fs from 'fs';
import * as path from 'path';

export function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function updateJson<T>(file: string, fallback: T, mutator: (current: T) => T): T {
  const current = readJson<T>(file, fallback);
  const next = mutator(current);
  writeJson(file, next);
  return next;
}
