import React, { useEffect, useState } from 'react';
import { api, on } from '../lib/api';
import { useToast } from '../components/Toast';
import { Modal, Tip, timeAgo } from '../components/Modal';
import type { Account } from '../../electron/shared/types';

export default function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msSession, setMsSession] = useState<{ userCode: string; verificationUri: string; message: string } | null>(null);
  const [msWaiting, setMsWaiting] = useState(false);
  const [offlineName, setOfflineName] = useState('');
  const [skinTarget, setSkinTarget] = useState<Account | null>(null);
  const toast = useToast();

  const reload = async () => {
    const [list, active] = await Promise.all([api.accountsList(), api.accountsActive()]);
    setAccounts(list);
    setActiveId(active?.id ?? null);
  };
  useEffect(() => { void reload(); }, []);

  useEffect(() => on('accounts:microsoft-result', (payload: { ok: boolean; account?: Account; error?: string; warn?: string | null }) => {
    setMsWaiting(false);
    if (payload.ok) {
      toast.toast(`登录成功：${payload.account?.name}${payload.warn ? `\n⚠ ${payload.warn}` : ''}`, 'ok');
      setMsSession(null);
      void reload();
    } else {
      toast.toast(payload.error ?? '微软登录失败', 'error');
      setMsSession(null);
    }
  }), []);

  const beginMicrosoft = async () => {
    try {
      setMsWaiting(true);
      const session = await api.accountsBeginMicrosoft();
      setMsSession({ userCode: session.userCode, verificationUri: session.verificationUri, message: session.message });
    } catch (e) {
      setMsWaiting(false);
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };

  const createOffline = async () => {
    const name = offlineName.trim();
    if (!name) return;
    try {
      await api.accountCreateOffline(name);
      toast.toast(`离线账号 ${name} 已创建`);
      setOfflineName('');
      void reload();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const randomName = () => {
    const adj = ['Steve', 'Alex', 'Echo', 'Nebula', 'Flint', 'Rowan', 'Cinder', 'Maple', 'Onyx', 'Zephyr', 'Tundra', 'Ember'];
    const num = Math.floor(Math.random() * 9000 + 1000);
    setOfflineName(`${adj[Math.floor(Math.random() * adj.length)]}${num}`);
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>账号</h1>
          <div className="sub">微软正版验证 + 离线账号；令牌只存在本机，绝不上传</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn primary" onClick={beginMicrosoft} disabled={msWaiting}>{msWaiting ? '等待验证…' : '登录微软账号'}</button>
        </div>
      </div>

      {msSession && (
        <Modal title="完成微软登录" onClose={() => setMsSession(null)} footer={
          <button className="btn" onClick={() => { api.openExternal(msSession.verificationUri); }}>打开验证页面 ↗</button>
        }>
          <p className="muted">1. 在浏览器打开 <strong>{msSession.verificationUri}</strong>（点右下角按钮可直接打开）<br />2. 输入下面的代码并确认登录</p>
          <div style={{ textAlign: 'center', margin: '18px 0' }}>
            <div className="mono" style={{ fontSize: 34, letterSpacing: 8, fontWeight: 800, color: 'var(--accent)', background: '#0b0e14', borderRadius: 12, padding: '16px 10px', userSelect: 'text' }}>{msSession.userCode}</div>
          </div>
          <p className="faint">代码 15 分钟内有效。登录成功后本窗口会自动关闭。<br />Xbox Live 授权失败时，最常见的原因是：系统时间不对（差 5 分钟就会被微软拒绝）——MCL 会在报错里直接告诉你。</p>
          <div className="row mt" style={{ justifyContent: 'center' }}><div className="progress" style={{ width: 200 }}><div style={{ width: '100%', animation: 'pulse 1.6s infinite' }} /></div></div>
        </Modal>
      )}

      <div className="panel">
        <div className="panel-title">我的账号（{accounts.length}）</div>
        {accounts.length === 0 && <div className="faint">还没有账号。登录微软账号可获得正版皮肤与多人游戏权益；离线账号适合局域网/单机/测试。</div>}
        <div className="list">
          {accounts.map(account => {
            const isActive = account.id === activeId;
            const skin = account.skinUrl;
            return (
              <div key={account.id} className="list-row" style={{ borderColor: isActive ? 'var(--accent-strong)' : 'transparent' }}>
                <div
                  style={{ width: 46, height: 46, borderRadius: 10, overflow: 'hidden', background: 'var(--panel-3)', flexShrink: 0, imageRendering: 'pixelated', cursor: 'pointer' }}
                  onClick={() => setSkinTarget(account)}
                  title="管理皮肤 / 披风"
                >
                  {skin ? <img src={skin} width={46} height={46} alt="" style={{ imageRendering: 'pixelated', objectFit: 'cover', objectPosition: 'left top' }} /> : <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', fontWeight: 800, color: 'var(--text-dim)' }}>{account.name[0]?.toUpperCase()}</div>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong>{account.name}</strong>
                    <span className={`tag ${account.type === 'microsoft' ? 'blue' : 'amber'}`}>{account.type === 'microsoft' ? '微软账号' : '离线账号'}</span>
                    {isActive && <span className="tag green">使用中</span>}
                  </div>
                  <div className="faint">UUID {account.uuid.slice(0, 13)}… · 上次使用 {timeAgo(account.lastUsedAt)}{account.type === 'microsoft' && account.expiresAt ? ` · 令牌有效至 ${new Date(account.expiresAt).toLocaleDateString()}` : ''}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {!isActive && <button className="btn small" onClick={() => api.accountSetActive(account.id).then(() => { toast.toast('已切换账号'); void reload(); })}>设为使用中</button>}
                  <button className="btn small" onClick={() => setSkinTarget(account)}>皮肤 / 披风</button>
                  <button className="btn small danger" onClick={() => api.accountRemove(account.id).then(() => { toast.toast('已移除账号', 'info'); void reload(); })}>移除</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">创建离线账号<Tip text="离线模式不能进正版验证服务器，皮肤只有自己可见。仅限局域网、单机与测试用途。" /></div>
        <div className="row">
          <input className="input" style={{ maxWidth: 280 }} placeholder="玩家名（英文字母/数字/下划线）" value={offlineName} onChange={e => setOfflineName(e.target.value)} onKeyDown={e => e.key === 'Enter' && createOffline()} maxLength={16} />
          <button className="btn" onClick={randomName}>🎲 随机</button>
          <button className="btn primary" onClick={createOffline}>创建</button>
        </div>
        <p className="faint mt">为什么离线皮肤别人看不见？离线模式下客户端不会向验证服务器上报皮肤，其他玩家只能看到默认皮肤或通过材质包看到你。这不是 MCL 的限制，是离线模式的设计。</p>
      </div>

      <div className="panel">
        <div className="panel-title">安全说明</div>
        <ul className="muted" style={{ paddingLeft: 18, lineHeight: 1.9 }}>
          <li>MCL 不提供/不保存你的微软密码——登录全程在微软官方页面完成，MCL 只拿到令牌。</li>
          <li>令牌仅保存在本机 <span className="mono">accounts.json</span>，不含遥测、不上传、不出售。</li>
          <li>MCL 完全开源（MIT），任何人可自行审计 <span className="mono">electron/services/auth.ts</span> 的登录实现。</li>
          <li>启动游戏只从 Mojang 官方渠道（或可切换的社区镜像）下载本体，不修改也不重新分发游戏文件。</li>
        </ul>
      </div>

      {skinTarget && (
        <SkinModal
          account={skinTarget}
          onClose={() => setSkinTarget(null)}
          onChanged={account => { setSkinTarget(account); void reload(); }}
        />
      )}
    </div>
  );
}

function SkinModal({ account, onClose, onChanged }: { account: Account; onClose: () => void; onChanged: (account: Account) => void }) {
  const [model, setModel] = useState<'classic' | 'slim'>(account.skinModel === 'slim' ? 'slim' : 'classic');
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const isMicrosoft = account.type === 'microsoft';

  const apply = async (label: string, fn: () => Promise<Account | null>) => {
    setBusy(label);
    try {
      const updated = await fn();
      if (updated) { onChanged(updated); toast.toast('已更新皮肤设置', 'ok'); }
      else toast.toast('已取消', 'info');
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setBusy(null); }
  };

  const headStyle: React.CSSProperties | undefined = account.skinUrl
    ? {
        width: 128,
        height: 128,
        backgroundImage: `url("${account.skinUrl}")`,
        backgroundSize: '1024px 1024px',
        backgroundPosition: '-128px -128px',
        imageRendering: 'pixelated',
      }
    : undefined;

  return (
    <Modal title={`皮肤 / 披风 · ${account.name}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>关闭</button>}>
      <div className="row" style={{ gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: 128, height: 128, borderRadius: 14, background: 'linear-gradient(135deg,#26313f,#141a24)', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
            {headStyle ? <div style={headStyle} /> : <span style={{ fontSize: 42, fontWeight: 800, color: 'var(--text-faint)' }}>{account.name[0]?.toUpperCase()}</span>}
          </div>
          <div className="faint mt">头部预览</div>
        </div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className={`tag ${isMicrosoft ? 'blue' : 'amber'}`}>{isMicrosoft ? '微软账号' : '离线账号'}</span>
            {account.skinModel && <span className="tag">{account.skinModel === 'slim' ? '纤细（Alex）' : '经典（Steve）'}</span>}
            {account.capeUrl && <span className="tag green">有披风预览</span>}
          </div>
          <div className="faint mt">UUID {account.uuid}</div>
          {account.skinUrl && (
            <div className="row mt" style={{ gap: 10, alignItems: 'flex-start' }}>
              <img src={account.skinUrl} alt="皮肤贴图" width={64} height={64} style={{ imageRendering: 'pixelated', borderRadius: 6, background: 'var(--panel-3)' }} />
              <div className="faint">完整皮肤贴图<br />（64×64 PNG）</div>
            </div>
          )}
          {account.capeUrl && (
            <div className="row mt" style={{ gap: 10, alignItems: 'flex-start' }}>
              <img src={account.capeUrl} alt="披风贴图" width={64} height={32} style={{ imageRendering: 'pixelated', borderRadius: 6, background: 'var(--panel-3)' }} />
              <div className="faint">披风预览贴图<br />（仅 MCL 界面显示）</div>
            </div>
          )}
        </div>
      </div>

      <div className="setting-row mt-lg">
        <div className="label">皮肤模型<Tip text="经典 Steve 是 4 格宽手臂，纤细 Alex 是 3 格宽手臂。选错会导致手臂贴图错位。只有上传/导入时会写入模型。" /></div>
        <div className="control">
          {(['classic', 'slim'] as const).map(m => (
            <label key={m} className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <input type="radio" name="skin-model" checked={model === m} onChange={() => setModel(m)} />
              {m === 'classic' ? '经典（Steve）' : '纤细（Alex）'}
            </label>
          ))}
        </div>
      </div>

      {isMicrosoft ? (
        <>
          <div className="row mt" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={!!busy} onClick={() => apply('upload', () => api.accountMicrosoftSkin(account.id, model))}>
              {busy === 'upload' ? '上传中…' : '上传皮肤到 Mojang'}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => apply('reset', () => api.accountMicrosoftSkinReset(account.id))}>
              {busy === 'reset' ? '处理中…' : '恢复默认皮肤'}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => apply('cape', () => api.accountLocalCape(account.id))}>导入披风预览</button>
            {account.capeUrl && <button className="btn ghost" disabled={!!busy} onClick={() => apply('capeClear', () => api.accountClearLocalCape(account.id))}>清除披风预览</button>}
          </div>
          <p className="faint mt">
            上传后皮肤由 Mojang 官方保存并同步给所有玩家（需要正版 Java 版与可用的 api.minecraftservices.com 网络）。
            披风无法通过公开 API 上传——MCL 的披风按钮只做本地预览，不会出现在游戏里。
          </p>
        </>
      ) : (
        <>
          <div className="row mt" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={!!busy} onClick={() => apply('skin', () => api.accountLocalSkin(account.id, model))}>
              {busy === 'skin' ? '导入中…' : '导入本地皮肤'}
            </button>
            {account.skinUrl && <button className="btn ghost" disabled={!!busy} onClick={() => apply('clear', () => api.accountClearLocalSkin(account.id))}>清除本地皮肤</button>}
            <button className="btn" disabled={!!busy} onClick={() => apply('cape', () => api.accountLocalCape(account.id))}>导入披风预览</button>
            {account.capeUrl && <button className="btn ghost" disabled={!!busy} onClick={() => apply('capeClear', () => api.accountClearLocalCape(account.id))}>清除披风预览</button>}
          </div>
          <div className="mt" style={{ padding: '10px 14px', borderRadius: 9, background: 'var(--amber-soft)', border: '1px solid rgba(240,180,91,.3)', fontSize: 13 }}>
            ⚠ 离线皮肤只保存在本机 <span className="mono">accounts.json</span>，仅 MCL 界面可见。离线模式不会向服务器上报皮肤，其他玩家看到的是默认皮肤——这是 Minecraft 离线模式的设计，不是 MCL 的限制。
          </div>
        </>
      )}
    </Modal>
  );
}
