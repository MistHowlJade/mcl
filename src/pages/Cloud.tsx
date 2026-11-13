import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { CloudApplyResult } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmModal, Tip, Toggle, formatBytes, timeAgo } from '../components/Modal';
import type { AppSettings, CloudProvider, CloudSettings, CloudSnapshotInfo } from '../../electron/shared/types';

const PROVIDERS: Array<{ id: CloudProvider; label: string; hint: string }> = [
  { id: 'off', label: '关闭', hint: '不同步任何内容。MCL 默认关闭云同步。' },
  { id: 'webdav', label: 'WebDAV（完整快照）', hint: '坚果云 / Nextcloud / 群晖等任何 WebDAV 服务。上传实例与服务器配置，可选打包存档。' },
  { id: 'gist', label: 'GitHub Gist（仅配置）', hint: '只同步设置、实例列表与服务器配置，速度快、体积小。需要 GitHub Token（gist 权限）。' },
];

export default function Cloud() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [draft, setDraft] = useState<CloudSettings | null>(null);
  const [snapshot, setSnapshot] = useState<CloudSnapshotInfo | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'upload' | 'download' | null>(null);
  const [downloadResult, setDownloadResult] = useState<CloudApplyResult | null>(null);
  const toast = useToast();

  const loadSettings = async () => {
    const s = await api.settingsGet();
    setSettings(s);
    setDraft(s.cloud);
  };

  const inspect = async () => {
    try { setSnapshot(await api.cloudInspect()); }
    catch (e) { setSnapshot({ exists: false, updatedAt: null, sizeBytes: null, location: '', note: e instanceof Error ? e.message : String(e) }); }
  };

  useEffect(() => {
    void loadSettings().then(inspect).catch(e => toast.toast(String(e), 'error'));
    /* eslint-disable-next-line */
  }, []);

  const update = (patch: Partial<CloudSettings>) => setDraft(prev => prev ? { ...prev, ...patch } : prev);

  const save = async (silent = false): Promise<boolean> => {
    if (!draft) return false;
    try {
      const saved = await api.settingsUpdate({ cloud: draft });
      setSettings(saved);
      setDraft(saved.cloud);
      if (!silent) toast.toast('云同步配置已保存', 'ok');
      return true;
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
      return false;
    }
  };

  const test = async () => {
    setBusy('test');
    setTestResult(null);
    try {
      if (!(await save(true))) return;
      setTestResult(await api.cloudTest());
      await inspect();
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(null); }
  };

  const upload = async () => {
    setConfirmAction(null);
    setBusy('upload');
    try {
      if (!(await save(true))) return;
      const info = await api.cloudUpload();
      setSnapshot(info);
      await loadSettings();
      toast.toast('已上传到云端', 'ok');
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(null); }
  };

  const download = async () => {
    setConfirmAction(null);
    setBusy('download');
    setDownloadResult(null);
    try {
      if (!(await save(true))) return;
      const result = await api.cloudDownload();
      setDownloadResult(result);
      await loadSettings();
      await inspect();
      toast.toast(`云端配置已应用：${result.instances} 个实例、${result.servers} 个服务器${result.saves ? `、${result.saves} 个存档` : ''}`, 'ok');
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(null); }
  };

  if (!draft || !settings) return <div className="empty"><div className="big">☁️</div>正在加载云同步设置…</div>;

  const provider = PROVIDERS.find(p => p.id === draft.provider) ?? PROVIDERS[0];
  const configured = draft.provider !== 'off';

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>云同步</h1>
          <div className="sub">换台电脑继续玩：同步实例配置、服务器配置，可选同步存档</div>
        </div>
        <button className="btn" onClick={() => { void inspect(); }} disabled={!!busy}>刷新云端状态</button>
      </div>

      <div className="panel">
        <div className="panel-title">同步方式<Tip text="MCL 不提供官方云服务器，也不会替你保管数据。用你自己的 WebDAV 或 GitHub Gist，账号密码只存在本机。" /></div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {PROVIDERS.map(p => (
            <button
              key={p.id}
              className={`btn ${draft.provider === p.id ? 'primary' : ''}`}
              onClick={() => { update({ provider: p.id }); setTestResult(null); }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="faint mt">{provider.hint}</p>

        {draft.provider === 'webdav' && (
          <>
            <div className="setting-row">
              <div className="label">WebDAV 地址<Tip text="填目录地址（如 https://dav.jianguoyun.com/dav/mcl/），MCL 会在里面读写 mcl-snapshot.zip；也可以直接填一个 .zip 文件地址。密码只存本机。" /></div>
              <div className="control"><input className="input" style={{ maxWidth: 440 }} placeholder="https://dav.example.com/mcl/" value={draft.webdavUrl} onChange={e => update({ webdavUrl: e.target.value })} /></div>
            </div>
            <div className="setting-row">
              <div className="label">用户名</div>
              <div className="control"><input className="input" style={{ maxWidth: 320 }} autoComplete="username" value={draft.webdavUsername} onChange={e => update({ webdavUsername: e.target.value })} /></div>
            </div>
            <div className="setting-row">
              <div className="label">密码 / 应用密码<Tip text="坚果云等需要「应用密码」而不是登录密码。只保存在本机 config.json，诊断包导出时会被隐藏。" /></div>
              <div className="control"><input className="input" type="password" style={{ maxWidth: 320 }} autoComplete="current-password" value={draft.webdavPassword} onChange={e => update({ webdavPassword: e.target.value })} /></div>
            </div>
            <div className="setting-row">
              <div className="label">同步存档<Tip text="开启后会把每个实例的 saves 打包进快照。存档可能很大（几百 MB 到几 GB），上传会明显变慢；只同步配置时保持关闭。" /></div>
              <div className="control"><Toggle checked={draft.includeSaves} onChange={v => update({ includeSaves: v })} label="同步存档" /></div>
            </div>
          </>
        )}

        {draft.provider === 'gist' && (
          <>
            <div className="setting-row">
              <div className="label">GitHub Token<Tip text="在 GitHub → Settings → Developer settings → Personal access tokens 创建，只需勾选 gist 权限。MCL 用它读写你自己的私密 Gist，不会上传到别处。" /></div>
              <div className="control"><input className="input" type="password" style={{ maxWidth: 440 }} autoComplete="off" placeholder="ghp_… 或 github_pat_…" value={draft.gistToken} onChange={e => update({ gistToken: e.target.value })} /></div>
            </div>
            <div className="setting-row">
              <div className="label">Gist ID<Tip text="留空 = 第一次上传时自动创建私密 Gist。换电脑时填同一个 ID 即可下载。Gist 里只有配置，不含令牌、密钥与存档。" /></div>
              <div className="control"><input className="input" style={{ maxWidth: 440 }} placeholder="留空 = 自动创建" value={draft.gistId} onChange={e => update({ gistId: e.target.value })} /></div>
            </div>
            <p className="faint">Gist 只同步：设置、实例列表、服务器配置。不会同步 accounts.json（微软令牌）、CurseForge 密钥、云同步密码、存档与模组文件。</p>
          </>
        )}

        <div className="row mt" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => save()} disabled={!!busy}>保存配置</button>
          <button className="btn" onClick={test} disabled={!!busy || !configured}>{busy === 'test' ? '连接中…' : '测试连接'}</button>
        </div>
        {testResult && (
          <div className="mt" style={{ padding: '10px 14px', borderRadius: 9, background: testResult.ok ? 'var(--accent-soft)' : 'var(--red-soft)', border: `1px solid ${testResult.ok ? 'rgba(93,211,158,.35)' : 'rgba(242,104,104,.4)'}` }}>
            {testResult.ok ? '✓ ' : '✗ '}{testResult.message}
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-title">云端快照</div>
        <div className="grid cols-2">
          <div>
            <div className="faint">状态</div>
            <div style={{ fontWeight: 700 }}>{snapshot?.exists ? '已有快照' : '云端还没有快照'}</div>
            <div className="faint mt">位置：<span className="mono">{snapshot?.location || '未配置'}</span></div>
            <div className="faint">更新时间：{snapshot?.updatedAt ? timeAgo(snapshot.updatedAt) : '—'}</div>
            <div className="faint">大小：{snapshot?.sizeBytes ? formatBytes(snapshot.sizeBytes) : '—'}</div>
            <div className="faint">说明：{snapshot?.note ?? '—'}</div>
          </div>
          <div>
            <div className="faint">上次同步</div>
            <div style={{ fontWeight: 700 }}>{draft.lastSyncAt ? `${timeAgo(draft.lastSyncAt)}（${draft.lastSyncDirection === 'download' ? '下载' : '上传'}）` : '还没有同步过'}</div>
            <div className="row mt" style={{ gap: 8, flexWrap: 'wrap' }}>
              <button className="btn primary" disabled={!!busy || !configured} onClick={() => setConfirmAction('upload')}>{busy === 'upload' ? '上传中…' : '上传到云端'}</button>
              <button className="btn" disabled={!!busy || !configured || !snapshot?.exists} onClick={() => setConfirmAction('download')}>{busy === 'download' ? '下载中…' : '从云端下载'}</button>
            </div>
          </div>
        </div>
      </div>

      {downloadResult && (
        <div className="panel">
          <div className="panel-title">上次下载结果</div>
          <div className="muted">
            已应用：设置 {downloadResult.settings ? '✓' : '—'} · 实例 {downloadResult.instances} 个 · 服务器 {downloadResult.servers} 个 · 存档 {downloadResult.saves} 个
          </div>
          {downloadResult.warnings.length > 0 && (
            <ul className="faint" style={{ paddingLeft: 18, marginTop: 8 }}>
              {downloadResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <p className="faint mt">实例和服务器只恢复了配置文件；游戏本体、模组、库文件会在下次启动 / 安装时按需下载。</p>
        </div>
      )}

      <div className="panel">
        <div className="panel-title">安全边界（请读一遍）</div>
        <ul className="muted" style={{ paddingLeft: 18, lineHeight: 1.9 }}>
          <li>绝不上传 <span className="mono">accounts.json</span>：里面是微软登录令牌，只能留在本机。</li>
          <li>绝不上传 CurseForge API Key、WebDAV 密码、GitHub Token；下载云端配置时也不会用远端的凭据覆盖本机。</li>
          <li>云端快照只包含 MCL 自己的设置、实例元数据、服务器配置；选择「同步存档」时才额外打包 saves。</li>
          <li>下载时只写入 MCL 数据目录，并对 ZIP 做目录穿越防护；不执行云端任何脚本。</li>
          <li>WebDAV / Gist 都是你自己的账号，MCL 没有中间服务器，也不收集任何同步内容。</li>
        </ul>
      </div>

      {confirmAction === 'upload' && (
        <ConfirmModal
          title="上传到云端"
          message={draft.provider === 'webdav'
            ? `将把当前配置${draft.includeSaves ? '与所有实例的存档' : ''}打包上传，覆盖云端已有的 mcl-snapshot.zip。\n\n确定继续？`
            : '将把当前配置写入你的私密 Gist（不含令牌与存档）。\n\n确定继续？'}
          confirmText="上传"
          onCancel={() => setConfirmAction(null)}
          onConfirm={upload}
        />
      )}

      {confirmAction === 'download' && (
        <ConfirmModal
          title="从云端下载"
          message="将用云端快照覆盖本机的设置、实例与服务器配置。MCL 不会删除你的游戏文件；存档只有在快照包含存档时才会覆盖。\n\n建议先确认当前配置已备份。确定继续？"
          confirmText="下载并应用"
          danger
          onCancel={() => setConfirmAction(null)}
          onConfirm={download}
        />
      )}
    </div>
  );
}