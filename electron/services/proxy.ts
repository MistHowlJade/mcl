/**
 * HTTP/HTTPS 代理支持（零第三方依赖）
 * - 仅支持 HTTP/HTTPS 代理（不支持 SOCKS5，避免自造协议栈）
 * - HTTP 目标：直接向代理发绝对 URL 请求
 * - HTTPS 目标：先 CONNECT 建隧道，再在隧道上做 TLS
 * - 所有启动器网络请求（下载/登录/API/云同步）共用同一份设置
 */
import * as http from 'http';
import * as https from 'https';
import * as tls from 'tls';
import { URL } from 'url';
import { getSettings } from './settings';

export interface ProxyConfig {
  host: string;
  port: number;
  secure: boolean;
  authHeader?: string;
  username?: string;
  password?: string;
}

/** 读取当前代理；未启用或配置非法时返回 null（走直连） */
function readProxy(requireDownloads: boolean): ProxyConfig | null {
  const settings = getSettings();
  if (settings.network.proxyMode !== 'manual') return null;
  if (requireDownloads && !settings.network.applyToDownloads) return null;
  const raw = settings.network.proxyUrl.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname;
  if (!host) return null;
  const port = parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const username = settings.network.proxyUsername || decodeURIComponent(parsed.username || '');
  const password = settings.network.proxyPassword || decodeURIComponent(parsed.password || '');
  const authHeader = username ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` : undefined;
  return { host, port, secure: parsed.protocol === 'https:', authHeader, username: username || undefined, password: password || undefined };
}

/** 启动器 HTTP 请求/下载使用的代理（受「下载走代理」开关控制） */
export function getProxyConfig(): ProxyConfig | null {
  return readProxy(true);
}

/** 把代理配置转成 JVM 系统属性（游戏内下载资源包/皮肤时使用） */
export function proxyJvmArgs(): string[] {
  const settings = getSettings();
  if (settings.network.proxyMode !== 'manual' || !settings.network.applyToGame) return [];
  const proxy = readProxy(false);
  if (!proxy) return [];
  const args = [
    `-Dhttp.proxyHost=${proxy.host}`, `-Dhttp.proxyPort=${proxy.port}`,
    `-Dhttps.proxyHost=${proxy.host}`, `-Dhttps.proxyPort=${proxy.port}`,
  ];
  if (settings.network.proxyUsername || proxy.username) {
    const user = settings.network.proxyUsername || proxy.username || '';
    const pass = settings.network.proxyPassword || proxy.password || '';
    args.push(`-Dhttp.proxyUser=${user}`, `-Dhttps.proxyUser=${user}`);
    args.push(`-Dhttp.proxyPassword=${pass}`, `-Dhttps.proxyPassword=${pass}`);
  }
  return args;
}

/** 代理是否已启用（供 UI 显示状态，不泄露密码） */
export function proxyEnabled(): boolean {
  return getProxyConfig() !== null;
}

/**
 * 创建一个已连接到目标的 ClientRequest（未 end，调用方负责写 body / end）
 * 返回 Promise 是为了 HTTPS 隧道需要异步 CONNECT。
 */
export async function createProxiedRequest(
  targetUrl: string,
  options: { method?: string; headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<http.ClientRequest> {
  let target: URL;
  try { target = new URL(targetUrl); } catch { throw new Error(`无法解析的 URL：${targetUrl}`); }
  const isHttps = target.protocol === 'https:';
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? 15000;
  const proxy = getProxyConfig();

  if (!proxy) {
    const client = isHttps ? https : http;
    const req = client.request({
      method,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers: options.headers ?? {},
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（>${timeoutMs}ms）：${targetUrl}`)));
    return req;
  }

  // HTTP 目标：请求行使用绝对 URL，交给代理转发
  if (!isHttps) {
    const client = proxy.secure ? https : http;
    const req = client.request({
      method,
      host: proxy.host,
      port: proxy.port,
      path: target.toString(),
      headers: {
        Host: target.host,
        ...(options.headers ?? {}),
        ...(proxy.authHeader ? { 'Proxy-Authorization': proxy.authHeader } : {}),
      },
      ...(proxy.secure ? { servername: proxy.host } : {}),
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`代理请求超时（>${timeoutMs}ms）：${targetUrl}`)));
    return req;
  }

  // HTTPS 目标：CONNECT 隧道 + TLS
  const targetPort = parseInt(target.port || '443', 10);
  const authority = `${target.hostname}:${targetPort}`;
  return new Promise<http.ClientRequest>((resolve, reject) => {
    const connectClient = proxy.secure ? https : http;
    const connectReq = connectClient.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: authority,
      headers: {
        Host: authority,
        ...(proxy.authHeader ? { 'Proxy-Authorization': proxy.authHeader } : {}),
      },
      ...(proxy.secure ? { servername: proxy.host } : {}),
    });
    connectReq.setTimeout(timeoutMs, () => connectReq.destroy(new Error(`代理 CONNECT 超时（>${timeoutMs}ms）`)));
    connectReq.once('error', reject);
    connectReq.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const hint = res.statusCode === 407 ? '（代理需要用户名/密码）' : '';
        reject(new Error(`代理 CONNECT 失败（HTTP ${res.statusCode}）${hint}，请检查代理地址、端口与认证`));
        return;
      }
      if (head?.length) socket.unshift(head);
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: true,
      }, () => {
        try {
          const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
          // 让 Agent 直接使用已经完成 TLS 握手的 socket（不要同时走 callback，避免 socket 被重复登记）
          (agent as any).createConnection = () => tlsSocket;
          const req = https.request({
            method,
            hostname: target.hostname,
            port: targetPort,
            path: target.pathname + target.search,
            headers: options.headers ?? {},
            agent,
          });
          req.setTimeout(timeoutMs, () => req.destroy(new Error(`代理请求超时（>${timeoutMs}ms）：${targetUrl}`)));
          resolve(req);
        } catch (e) {
          tlsSocket.destroy();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
      tlsSocket.once('error', reject);
    });
    connectReq.end();
  });
}