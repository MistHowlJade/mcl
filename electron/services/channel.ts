/**
 * 构建渠道：打包脚本在应用根目录写入 channel.json（stable / dev）。
 * 源码直跑或单文件便携版没有该文件，按稳定版处理；dev 版会打开 DevTools 并显示「开发版」标识。
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AppChannel } from '../shared/types';

const VALID: AppChannel[] = ['stable', 'dev'];

export function getChannel(): AppChannel {
  try {
    const file = path.join(__dirname, '..', 'channel.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { channel?: string };
    if (VALID.includes(raw.channel as AppChannel)) return raw.channel as AppChannel;
  } catch { /* 没有渠道文件或内容损坏都按稳定版处理 */ }
  return 'stable';
}

export const CHANNEL_LABEL: Record<AppChannel, string> = { stable: '稳定版', dev: '开发版' };
