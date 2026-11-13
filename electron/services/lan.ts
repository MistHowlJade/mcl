/**
 * 局域网世界扫描：监听 Minecraft 的局域网广播（224.0.2.60:4445）
 * 对应「对局域网开放」后自动发现，不需要玩家手动问 IP。
 */
import * as dgram from 'dgram';
import * as os from 'os';
import { LanWorld } from '../shared/types';

const MULTICAST = '224.0.2.60';
const PORT = 4445;

function localAddresses(): Set<string> {
  const set = new Set<string>(['127.0.0.1', 'localhost']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (!item.internal) set.add(item.address);
    }
  }
  return set;
}

export function scanLanWorlds(timeoutMs = 4500): Promise<LanWorld[]> {
  return new Promise(resolve => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Map<string, LanWorld>();
    const locals = localAddresses();
    let finished = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      try { socket.close(); } catch { /* ignore */ }
      resolve([...found.values()].sort((a, b) => a.motd.localeCompare(b.motd)));
    };

    timer = setTimeout(finish, Math.max(1500, Math.min(15000, timeoutMs)));
    socket.once('error', finish);
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      const motdRaw = /\[MOTD\]([\s\S]*?)\[\/MOTD\]/i.exec(text)?.[1] ?? 'Minecraft 局域网世界';
      const motd = motdRaw.replace(/\u00a7[\da-fk-or]/gi, '').replace(/\s+/g, ' ').trim() || 'Minecraft 局域网世界';
      const port = parseInt(/\[AD\]([\s\S]*?)\[\/AD\]/i.exec(text)?.[1] ?? '', 10) || 25565;
      const key = `${rinfo.address}:${port}`;
      found.set(key, {
        motd,
        address: rinfo.address,
        port,
        local: locals.has(rinfo.address),
      });
    });
    try {
      socket.bind(PORT, () => {
        try { socket.addMembership(MULTICAST); } catch { /* 没有可用网卡时保持监听，仍可能收到单播 */ }
      });
    } catch {
      finish();
    }
  });
}