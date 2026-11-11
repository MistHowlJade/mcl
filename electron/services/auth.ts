/**
 * 账号系统
 * 微软账号（Live 设备码流程：00000000402b5328 是微软 Live 的公共客户端，国内网络可用）+ 离线账号
 * 痛点 #17（OAuth 各家实现参差）#18（错误码人话翻译）#20（系统时间错误检测）#22（多账号）#24（名字说明）
 *
 * 说明：设备码端点为 login.live.com 的 oauth20_*.srf（consumers 租户的 v2.0 端点不接受该 Live 客户端）。
 */
import * as crypto from 'crypto';
import { fetchWithTimeout } from './net';
import * as paths from './paths';
import { Account } from '../shared/types';
import { readJson, writeJson } from './store';

const CLIENT_ID = '00000000402b5328';
const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';

export interface MicrosoftLoginSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  message: string;
}

interface StoredAccount extends Account {
  /** Minecraft 服务访问令牌（24h） */
  accessToken?: string | null;
  /** 微软刷新令牌（长期） */
  refreshToken?: string | null;
}

interface AccountsFile {
  accounts: StoredAccount[];
  activeId: string | null;
}

const load = (): AccountsFile => readJson<AccountsFile>(paths.accountsFile(), { accounts: [], activeId: null });
const save = (data: AccountsFile) => writeJson(paths.accountsFile(), data);

const publicView = (a: StoredAccount): Account => ({
  id: a.id,
  type: a.type,
  name: a.name,
  uuid: a.uuid,
  skinUrl: a.skinUrl ?? null,
  expiresAt: a.expiresAt ?? null,
  lastUsedAt: a.lastUsedAt,
});

export function listAccounts(): Account[] {
  return load().accounts.map(publicView);
}

export function getActiveAccount(): Account | null {
  const data = load();
  const hit = data.accounts.find(a => a.id === data.activeId);
  return hit ? publicView(hit) : null;
}

export function setActiveAccount(id: string): void {
  const data = load();
  if (data.accounts.some(a => a.id === id)) {
    data.activeId = id;
    save(data);
  }
}

export function removeAccount(id: string): void {
  const data = load();
  data.accounts = data.accounts.filter(a => a.id !== id);
  if (data.activeId === id) data.activeId = data.accounts[0]?.id ?? null;
  save(data);
}

/* ---------- 离线账号 ---------- */
export function offlineUuid(name: string): string {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createOfflineAccount(name: string, skinUrl?: string | null): Account {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(trimmed)) {
    throw new Error('离线玩家名只能包含英文字母、数字、下划线，且不超过 16 个字符');
  }
  const data = load();
  const account: StoredAccount = {
    id: `offline:${trimmed.toLowerCase()}`,
    type: 'offline',
    name: trimmed,
    uuid: offlineUuid(trimmed),
    skinUrl: skinUrl ?? null,
    expiresAt: null,
    lastUsedAt: Date.now(),
  };
  data.accounts = data.accounts.filter(a => a.id !== account.id);
  data.accounts.push(account);
  if (!data.activeId) data.activeId = account.id;
  save(data);
  return publicView(account);
}

/* ---------- 微软账号：设备码 ---------- */
export async function beginMicrosoftLogin(): Promise<MicrosoftLoginSession> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    scope: LIVE_SCOPE,
    response_type: 'device_code',
  }).toString();
  const res = await fetchWithTimeout(DEVICE_CODE_URL, {
    method: 'POST',
    timeoutMs: 20000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (res.status >= 400) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = JSON.parse(res.body.toString('utf8'));
      detail = json.error_description ?? json.error ?? detail;
    } catch { /* 用默认描述 */ }
    throw new Error(`无法启动微软登录：${detail}`);
  }
  const json = JSON.parse(res.body.toString('utf8'));
  return {
    deviceCode: json.device_code,
    userCode: json.user_code ?? json.user_code,
    verificationUri: json.verification_uri ?? 'https://microsoft.com/link',
    expiresIn: json.expires_in ?? 900,
    interval: json.interval ?? 5,
    message: json.message ?? `请在浏览器中打开 ${json.verification_uri ?? 'https://microsoft.com/link'} 并输入代码 ${json.user_code}`,
  };
}

/** XSTS XErr → 人话（痛点 #18） */
export function translateXstsError(xerr: number | string | undefined, raw?: string): string {
  const code = String(xerr ?? '');
  switch (code) {
    case '2148916233': return '该微软账号还没有 Xbox 个人资料。请先用浏览器打开 xbox.com 登录一次，创建资料后再试。';
    case '2148916234': return '当前地区不支持 Xbox Live 服务。';
    case '2148916235': return 'Xbox Live 服务暂时异常，请稍后再试。';
    case '2148916236': return '需要先同意 Xbox Live 服务条款（用该账号在浏览器登录一次 xbox.com 即可）。';
    case '2148916237': return '该账号需要完成成年人验证后才能使用 Xbox Live。';
    case '2148916238': return '该账号是未成年账号，需要家长先把它加入家庭组并同意。';
    case '2148916242': return '该账号需要完成家长验证。';
    default: return `Xbox Live 授权失败（XErr ${code || '未知'}）${raw ? `：${raw}` : ''}`;
  }
}

function checkClockSkew(resHeaders: Record<string, any>): string | null {
  const dateHeader = resHeaders?.['date'] ?? resHeaders?.['Date'];
  if (!dateHeader) return null;
  const serverTime = new Date(Array.isArray(dateHeader) ? dateHeader[0] : dateHeader).getTime();
  if (Number.isNaN(serverTime)) return null;
  const skewMs = Math.abs(serverTime - Date.now());
  if (skewMs > 5 * 60 * 1000) {
    return `你的系统时间与服务器相差超过 ${Math.round(skewMs / 60000)} 分钟，微软登录会因此被拒绝。请校准系统日期/时间后重试。（这是最常见的"明明密码对却登不上"的原因）`;
  }
  return null;
}

async function pollMicrosoftToken(session: MicrosoftLoginSession): Promise<{ msToken: string; refreshToken: string | null; expiresIn: number; skewWarning: string | null }> {
  const deadline = Date.now() + session.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, session.interval * 1000));
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: session.deviceCode,
    }).toString();
    const res = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      timeoutMs: 20000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    let json: any = {};
    try { json = JSON.parse(res.body.toString('utf8')); } catch { /* keep empty */ }
    if (res.status < 400) {
      return {
        msToken: json.access_token,
        refreshToken: json.refresh_token ?? null,
        expiresIn: json.expires_in ?? 86400,
        skewWarning: checkClockSkew(res.headers as Record<string, any>),
      };
    }
    const err = String(json.error ?? '');
    if (err === 'authorization_pending') continue;           // 用户还没完成
    if (err === 'slow_down') { await new Promise(r => setTimeout(r, 5000)); continue; }
    if (err === 'authorization_declined') throw new Error('你在浏览器中拒绝了此次登录请求。');
    if (err === 'expired_token') throw new Error('登录代码已过期，请重新发起登录。');
    throw new Error(`微软登录失败：${json.error_description ?? json.error ?? `HTTP ${res.status}`}`);
  }
  throw new Error('登录超时：验证代码已过期，请重试。');
}

export interface MicrosoftLoginResult {
  account: Account;
  warn?: string | null;
}

/** 用 MS access_token 走完 Xbox → XSTS → Minecraft 链路，返回 MC 令牌与资料 */
async function mcTokenFromMsToken(msToken: string): Promise<{ mcToken: string; mcExpiresIn: number; name: string; uuid: string; skinUrl: string | null }> {
  // Xbox Live 用户令牌
  const xblRes = await fetchWithTimeout('https://user.auth.xboxlive.com/user/authenticate', {
    method: 'POST',
    timeoutMs: 20000,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    }),
  });
  if (xblRes.status >= 400) {
    const skew = checkClockSkew(xblRes.headers as Record<string, any>);
    throw new Error(skew ?? `Xbox Live 认证失败（HTTP ${xblRes.status}）。请确认系统时间正确，或稍后再试。`);
  }
  const xbl = JSON.parse(xblRes.body.toString('utf8'));
  const xblToken: string = xbl.Token;
  const uhs: string = xbl?.DisplayClaims?.xui?.[0]?.uhs ?? '';

  // XSTS
  const xstsRes = await fetchWithTimeout('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    timeoutMs: 20000,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }),
  });
  if (xstsRes.status >= 400) {
    let xerr: string | undefined;
    try { xerr = String(JSON.parse(xstsRes.body.toString('utf8'))?.XErr ?? ''); } catch { /* ignore */ }
    throw new Error(translateXstsError(xerr, undefined));
  }
  const xsts = JSON.parse(xstsRes.body.toString('utf8'));
  const xstsToken: string = xsts.Token;

  // Minecraft 服务令牌
  const mcRes = await fetchWithTimeout('https://api.minecraftservices.com/authentication/login_with_xbox', {
    method: 'POST',
    timeoutMs: 20000,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xstsToken}` }),
  });
  if (mcRes.status >= 400) {
    throw new Error(`Minecraft 服务认证失败（HTTP ${mcRes.status}）。`);
  }
  const mcJson = JSON.parse(mcRes.body.toString('utf8'));
  const mcToken: string = mcJson.access_token;
  const mcExpiresIn: number = mcJson.expires_in ?? 86400;

  // 玩家资料（同时检查是否购买了 Java 版）
  const profRes = await fetchWithTimeout('https://api.minecraftservices.com/minecraft/profile', {
    timeoutMs: 20000,
    headers: { Authorization: `Bearer ${mcToken}`, Accept: 'application/json' },
  });
  if (profRes.status === 404 || profRes.status === 401 || profRes.status === 403) {
    throw new Error('该微软账号没有购买 Minecraft Java 版，因此无法登录。\n请确认在 minecraft.net 购买过 Java Edition，或使用离线账号。');
  }
  if (profRes.status >= 400) {
    throw new Error(`获取玩家资料失败（HTTP ${profRes.status}）。`);
  }
  const profile = JSON.parse(profRes.body.toString('utf8'));
  const rawId = String(profile.id).replace(/-/g, '');
  const dashed = rawId.length === 32 ? `${rawId.slice(0, 8)}-${rawId.slice(8, 12)}-${rawId.slice(12, 16)}-${rawId.slice(16, 20)}-${rawId.slice(20)}` : rawId;
  return {
    mcToken,
    mcExpiresIn,
    name: profile.name,
    uuid: dashed,
    skinUrl: profile?.skins?.[0]?.url ?? null,
  };
}

/** 完整走通 Xbox → XSTS → Minecraft 服务 链路并保存账号 */
export async function finishMicrosoftLogin(session: MicrosoftLoginSession): Promise<MicrosoftLoginResult> {
  const { msToken, refreshToken, skewWarning } = await pollMicrosoftToken(session);
  const chain = await mcTokenFromMsToken(msToken);

  const data = load();
  const account: StoredAccount = {
    id: `microsoft:${chain.uuid.replace(/-/g, '')}`,
    type: 'microsoft',
    name: chain.name,
    uuid: chain.uuid,
    skinUrl: chain.skinUrl,
    accessToken: chain.mcToken,
    refreshToken: refreshToken ?? null,
    expiresAt: Date.now() + chain.mcExpiresIn * 1000,
    lastUsedAt: Date.now(),
  };
  data.accounts = data.accounts.filter(a => a.id !== account.id);
  data.accounts.push(account);
  data.activeId = account.id;
  save(data);
  return { account: publicView(account), warn: skewWarning };
}

/** 用刷新令牌换新的 MS token，再重跑整条链路 */
async function refreshMicrosoftAccount(account: StoredAccount): Promise<StoredAccount | null> {
  if (!account.refreshToken) return null;
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      scope: LIVE_SCOPE,
    }).toString();
    const res = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      timeoutMs: 20000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    if (res.status >= 400) return null;
    const json = JSON.parse(res.body.toString('utf8'));
    const chain = await mcTokenFromMsToken(json.access_token);
    account.accessToken = chain.mcToken;
    if (json.refresh_token) account.refreshToken = json.refresh_token;
    account.expiresAt = Date.now() + chain.mcExpiresIn * 1000;
    account.name = chain.name;
    account.uuid = chain.uuid;
    account.skinUrl = chain.skinUrl;
    account.lastUsedAt = Date.now();
    return account;
  } catch {
    return null;
  }
}

/** 获取可用于启动的 accessToken（自动刷新）；返回 null 表示需要重新登录 */
export async function getValidAccessToken(accountId: string): Promise<{ accessToken: string; userType: 'msa' | 'legacy' | 'offline'; uuid: string; name: string } | null> {
  const data = load();
  const account = data.accounts.find(a => a.id === accountId);
  if (!account) return null;
  if (account.type === 'offline') {
    return { accessToken: '0', userType: 'legacy', uuid: account.uuid, name: account.name };
  }
  if (!account.accessToken || !account.expiresAt || account.expiresAt - Date.now() <= 60_000) {
    const refreshed = await refreshMicrosoftAccount(account);
    if (!refreshed) return null;
    const idx = data.accounts.findIndex(a => a.id === account.id);
    data.accounts[idx] = refreshed;
  }
  save(data);
  return { accessToken: account.accessToken!, userType: 'msa', uuid: account.uuid, name: account.name };
}

