import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, on } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmModal, Modal, Tip, Toggle, formatBytes, timeAgo } from '../components/Modal';
import type { ServerBackupInfo, ServerInfo, ServerLoader, ServerProperties, ServerStatus } from '../../electron/shared/types';

type Tab = 'console' | 'settings' | 'properties' | 'backups';

const STATUS_INFO: Record<ServerStatus, { label: string; cls: string }> = {
  stopped: { label: '已停止', cls: '' },
  preparing: { label: '准备中', cls: 'amber' },
  starting: { label: '启动中', cls: 'amber' },
  running: { label: '运行中', cls: 'green' },
  stopping: { label: '停止中', cls: 'amber' },
  crashed: { label: '已崩溃', cls: 'red' },
};

const PROPERTY_FIELDS: Array<{ key: string; label: string; tip: string; kind: 'text' | 'number' | 'boolean' | 'select'; options?: Array<{ value: string; label: string }> }> = [
  { key: 'motd', label: '服务器标语（MOTD）', tip: '多人游戏列表里显示的服务器名字。支持颜色代码 §。', kind: 'text' },
  { key: 'server-port', label: '端口', tip: '玩家连接使用的端口，默认 25565。改了之后要在路由器/防火墙放行新端口。', kind: 'number' },
  { key: 'online-mode', label: '正版验证', tip: '开启后只允许微软正版账号进入。离线服务器（局域网/朋友之间）可以关闭，但会失去账号保护。', kind: 'boolean' },
  { key: 'max-players', label: '最大玩家数', tip: '允许同时在线的玩家上限。', kind: 'number' },
  { key: 'difficulty', label: '难度', tip: 'peaceful 和平 / easy 简单 / normal 普通 / hard 困难。', kind: 'select', options: [
    { value: 'peaceful', label: '和平' }, { value: 'easy', label: '简单' }, { value: 'normal', label: '普通' }, { value: 'hard', label: '困难' },
  ] },
  { key: 'gamemode', label: '默认游戏模式', tip: '新玩家进入服务器时的默认模式。', kind: 'select', options: [
    { value: 'survival', label: '生存' }, { value: 'creative', label: '创造' }, { value: 'adventure', label: '冒险' }, { value: 'spectator', label: '旁观' },
  ] },
  { key: 'view-distance', label: '视距', tip: '服务器向玩家发送多远的区块。越大越吃内存与带宽，10 是安全值。', kind: 'number' },
  { key: 'pvp', label: '允许 PVP', tip: '玩家之间能否互相造成伤害。', kind: 'boolean' },
  { key: 'white-list', label: '白名单', tip: '开启后只有白名单里的玩家能进入。添加玩家需要在控制台执行 whitelist add <名字>。', kind: 'boolean' },
  { key: 'enable-command-block', label: '命令方块', tip: '是否允许使用命令方块。', kind: 'boolean' },
  { key: 'allow-flight', label: '允许飞行', tip: '生存模式下允许飞行（防止反作弊误踢使用鞘翅/模组的玩家）。', kind: 'boolean' },
  { key: 'level-name', label: '世界文件夹名', tip: '世界数据保存在服务器目录下的这个文件夹里。修改后服务器会读取另一个世界。', kind: 'text' },
  { key: 'level-seed', label: '世界种子', tip: '只在首次生成世界时生效；留空 = 随机。', kind: 'text' },
  { key: 'enable-status', label: '公开状态', tip: '关闭后多人游戏列表不会显示在线人数与 MOTD。', kind: 'boolean' },
];

export default function Servers() {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [tab, setTab] = useState<Tab>('console');
  const [logs, setLogs] = useState<string[]>([]);
  const [command, setCommand] = useState('');
  const [properties, setProperties] = useState<ServerProperties>({});
  const [propDraft, setPropDraft] = useState<ServerProperties>({});
  const [backups, setBackups] = useState<ServerBackupInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [eulaServer, setEulaServer] = useState<ServerInfo | null>(null);
  const [eulaChecked, setEulaChecked] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ServerInfo | null>(null);
  const [killTarget, setKillTarget] = useState<ServerInfo | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<ServerBackupInfo | null>(null);
  const [backupDeleteTarget, setBackupDeleteTarget] = useState<ServerBackupInfo | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef<string | null>(null);
  const toast = useToast();

  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const patchServerInList = (info: ServerInfo) => {
    setServers(prev => {
      const exists = prev.some(s => s.id === info.id);
      return exists ? prev.map(s => s.id === info.id ? info : s) : [info, ...prev];
    });
    setServer(prev => prev?.id === info.id ? { ...prev, ...info } : prev);
  };

  const reloadServers = async () => {
    try {
      const list = await api.serversList();
      setServers(list);
      setSelectedId(prev => prev ?? list[0]?.id ?? null);
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  useEffect(() => { void reloadServers(); /* eslint-disable-next-line */ }, []);

  useEffect(() => {
    const offStatus = on('server:status', (info: ServerInfo) => patchServerInList(info));
    const offLog = on('server:log', (payload: { serverId: string; line: string }) => {
      if (!payload?.serverId || payload.serverId !== selectedIdRef.current) return;
      setLogs(prev => [...prev.slice(-500), payload.line]);
    });
    return () => { offStatus(); offLog(); };
  }, []);

  useEffect(() => {
    if (!selectedId) { setServer(null); setLogs([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const [info, log, props, bks] = await Promise.all([
          api.serverGet(selectedId), api.serverLog(selectedId, 300), api.serverProperties(selectedId), api.serverBackups(selectedId),
        ]);
        if (cancelled) return;
        setServer(info);
        setLogs(log);
        setProperties(props);
        setPropDraft(props);
        setBackups(bks);
      } catch (e) { if (!cancelled) toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    })();
    return () => { cancelled = true; };
    /* eslint-disable-next-line */
  }, [selectedId]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const refreshDetail = async () => {
    if (!selectedId) return;
    try {
      const [info, log, bks] = await Promise.all([api.serverGet(selectedId), api.serverLog(selectedId, 300), api.serverBackups(selectedId)]);
      if (info) { setServer(info); patchServerInList(info); }
      setLogs(log);
      setBackups(bks);
    } catch { /* 刷新失败不打扰 */ }
  };

  const run = async (label: string, fn: () => Promise<unknown>, success?: string) => {
    setBusy(label);
    try {
      await fn();
      if (success) toast.toast(success, 'ok');
      await refreshDetail();
      await reloadServers();
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const start = (info: ServerInfo) => {
    if (!info.eulaAccepted) { setEulaChecked(false); setEulaServer(info); return; }
    void run('start', () => api.serverStart(info.id), '服务器正在启动，控制台会显示进度');
  };

  const acceptEulaAndStart = async () => {
    if (!eulaServer) return;
    setBusy('eula');
    try {
      await api.serverAcceptEula(eulaServer.id);
      setEulaServer(null);
      toast.toast('已同意 EULA，开始启动服务器', 'ok');
      await api.serverStart(eulaServer.id);
      await refreshDetail();
      await reloadServers();
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const sendCommand = async () => {
    if (!server || !command.trim()) return;
    try {
      await api.serverSendCommand(server.id, command.trim());
      setCommand('');
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const saveProperties = async () => {
    if (!server) return;
    try {
      const next = await api.serverSaveProperties(server.id, propDraft);
      setProperties(next);
      setPropDraft(next);
      toast.toast('server.properties 已保存。部分设置需要重启服务器生效。', 'ok');
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const saveServerConfig = async () => {
    if (!server) return;
    await run('save', () => api.serverUpdate(server.id, {
      name: server.name,
      port: server.port,
      memoryMB: server.memoryMB,
      javaPath: server.javaPath ?? null,
      jvmArgsExtra: server.jvmArgsExtra ?? '',
    }), '服务器设置已保存');
  };

  const doDelete = async () => {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setDeleteTarget(null);
    setBusy('delete');
    try {
      const r = await api.serverDelete(id, true);
      toast.toast(r.ok ? `服务器已删除${r.backupPath ? '，删除前已自动打包备份' : ''}` : '服务器不存在', 'ok');
      setSelectedId(null);
      setServer(null);
      await reloadServers();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setBusy(null); }
  };

  const busyNow = !!busy;
  const status = server ? STATUS_INFO[server.status] : null;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>服务器</h1>
          <div className="sub">原版 / Fabric / Quilt / Forge / NeoForge，一键安装、启停、改配置、备份世界</div>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>＋ 创建服务器</button>
      </div>

      {servers.length === 0 ? (
        <div className="empty">
          <div className="big">🖥️</div>
          <div style={{ fontWeight: 700 }}>还没有服务器</div>
          <div className="faint mt">MCL 会自动下载服务端与 Java，装好后点启动即可。支持联机给朋友玩，也可以只开在局域网。</div>
          <div className="row mt" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => setCreating(true)}>创建第一个服务器</button>
          </div>
        </div>
      ) : (
        <div className="grid cols-3">
          {servers.map(s => {
            const st = STATUS_INFO[s.status];
            return (
              <div
                key={s.id}
                className="panel"
                style={{ cursor: 'pointer', borderColor: selectedId === s.id ? 'var(--accent-strong)' : undefined, background: selectedId === s.id ? 'var(--accent-soft)' : undefined }}
                onClick={() => setSelectedId(s.id)}
              >
                <div className="row spread">
                  <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.name}</strong>
                  <span className={`tag ${st.cls}`}>{st.label}</span>
                </div>
                <div className="faint mt">{s.mcVersion} · {s.loader}{s.loaderVersion ? ` ${s.loaderVersion}` : ''}</div>
                <div className="row mt" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <span className="tag blue">端口 {s.port}</span>
                  <span className="tag">{s.players.length} 人在线</span>
                  <span className="tag">{formatBytes(s.diskBytes)}</span>
                </div>
                <div className="faint mt">上次启动：{timeAgo(s.lastStartedAt)}</div>
              </div>
            );
          })}
        </div>
      )}

      {server && (
        <div className="panel mt-lg">
          <div className="row spread" style={{ flexWrap: 'wrap', gap: 10 }}>
            <div>
              <div className="row" style={{ gap: 10 }}>
                <h2 style={{ fontSize: 20 }}>{server.name}</h2>
                {status && <span className={`tag ${status.cls}`}>{status.label}</span>}
                {server.pid && <span className="tag">PID {server.pid}</span>}
              </div>
              <div className="faint mt">
                {server.mcVersion} · {server.loader}{server.loaderVersion ? ` ${server.loaderVersion}` : ''} · 端口 {server.port} · 内存 {server.memoryMB} MB · 在线：{server.players.length > 0 ? server.players.join('、') : '无'}
              </div>
            </div>
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {server.status === 'running' || server.status === 'starting' || server.status === 'preparing' ? (
                <button className="btn" disabled={busyNow} onClick={() => run('stop', () => api.serverStop(server.id), '已发送停止命令')}>{busy === 'stop' ? '停止中…' : '停止服务器'}</button>
              ) : (
                <button className="btn primary" disabled={busyNow} onClick={() => start(server)}>{busy === 'start' ? '启动中…' : '启动服务器'}</button>
              )}
              <button className="btn danger" disabled={busyNow || !server.pid} onClick={() => setKillTarget(server)}>强制结束</button>
              <button className="btn" disabled={busyNow} onClick={() => run('prepare', () => api.serverPrepare(server.id), '服务端已重新安装')}>{busy === 'prepare' ? '安装中…' : server.prepared ? '重新安装' : '安装服务端'}</button>
              <button className="btn" onClick={() => api.serverOpenDir(server.id)}>打开目录</button>
              <button className="btn danger" disabled={busyNow} onClick={() => setDeleteTarget(server)}>删除…</button>
            </div>
          </div>

          {busy && <div className="faint mt">正在执行：{busy === 'prepare' ? '下载并安装服务端（首次可能需要几分钟）…' : busy === 'stop' ? '等待服务器保存世界并退出…' : '请稍候…'}</div>}

          <div className="row mt-lg" style={{ gap: 8, flexWrap: 'wrap' }}>
            {([
              ['console', '控制台'], ['settings', '服务器设置'], ['properties', 'server.properties'], ['backups', '世界备份'],
            ] as Array<[Tab, string]>).map(([id, label]) => (
              <button key={id} className={`btn ${tab === id ? 'primary' : ''}`} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>

          {tab === 'console' && (
            <div className="mt">
              <div ref={logRef} className="log-strip" style={{ height: 320, overflowY: 'auto' }}>
                {logs.length === 0 ? <div className="line">暂无日志。启动服务器后会在这里实时显示。</div> : logs.map((line, i) => (
                  <div key={i} className={`line ${/error|exception|failed|错误/i.test(line) ? 'err' : /warn|警告/i.test(line) ? 'warn' : /^\[install\]|^\[mcl\]/.test(line) ? 'mcl' : ''}`}>{line}</div>
                ))}
              </div>
              <div className="row mt">
                <input
                  className="input"
                  style={{ flex: 1 }}
                  placeholder={server.status === 'running' ? '输入服务器命令，如 list / op 玩家名 / stop' : '服务器未运行，无法发送命令'}
                  value={command}
                  disabled={server.status !== 'running'}
                  onChange={e => setCommand(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && sendCommand()}
                />
                <button className="btn primary" disabled={server.status !== 'running' || !command.trim()} onClick={sendCommand}>发送</button>
                <button className="btn" onClick={() => setLogs([])}>清空显示</button>
              </div>
              <p className="faint mt">停止服务器请优先用「停止服务器」或 stop 命令，让世界正常保存。强制结束可能丢失最近几秒的进度。</p>
            </div>
          )}

          {tab === 'settings' && (
            <div className="mt">
              <div className="setting-row">
                <div className="label">服务器名称</div>
                <div className="control"><input className="input" style={{ maxWidth: 320 }} value={server.name} onChange={e => setServer({ ...server, name: e.target.value })} /></div>
              </div>
              <div className="setting-row">
                <div className="label">端口<Tip text="玩家连接端口。修改后需要重启服务器，并确保防火墙/路由器放行。端口冲突会导致启动失败。" /></div>
                <div className="control">
                  <input className="input" style={{ width: 120 }} type="number" min={1} max={65535} value={server.port} onChange={e => setServer({ ...server, port: parseInt(e.target.value, 10) || 25565 })} />
                  <button className="btn small" onClick={async () => {
                    try {
                      const ok = await api.serverCheckPort(server.port);
                      toast.toast(ok ? `端口 ${server.port} 可用` : `端口 ${server.port} 已被占用`, ok ? 'ok' : 'error');
                    } catch (e) { toast.toast(String(e), 'error'); }
                  }}>检查端口</button>
                </div>
              </div>
              <div className="setting-row">
                <div className="label">最大内存（MB）<Tip text="服务端比客户端更吃内存：原版 2G 起，模组服建议 4G–8G。设置过大会导致系统换页反而更卡。" /></div>
                <div className="control"><input className="input" style={{ width: 130 }} type="number" min={512} max={32768} step={256} value={server.memoryMB} onChange={e => setServer({ ...server, memoryMB: parseInt(e.target.value, 10) || 2048 })} /></div>
              </div>
              <div className="setting-row">
                <div className="label">Java 路径<Tip text="留空 = 由 MCL 按 Minecraft 版本自动匹配/下载。只有想强制使用某个 Java 时才填写。" /></div>
                <div className="control"><input className="input" style={{ maxWidth: 420 }} placeholder="留空 = 自动管理" value={server.javaPath ?? ''} onChange={e => setServer({ ...server, javaPath: e.target.value || null })} /></div>
              </div>
              <div className="setting-row">
                <div className="label">附加 JVM 参数<Tip text="每行一条或空格分隔。例如 -XX:+UseG1GC。不确定就不要填。" /></div>
                <div className="control"><textarea className="input" style={{ width: '100%', maxWidth: 480, minHeight: 70 }} value={server.jvmArgsExtra ?? ''} onChange={e => setServer({ ...server, jvmArgsExtra: e.target.value })} /></div>
              </div>
              <div className="row mt" style={{ justifyContent: 'flex-end' }}>
                <button className="btn primary" disabled={busyNow} onClick={saveServerConfig}>保存服务器设置</button>
              </div>
            </div>
          )}

          {tab === 'properties' && (
            <div className="mt">
              <p className="faint">这些是给玩家用的服务器规则，保存后写入 server.properties；标有「需重启」的改动在重启服务器后生效。</p>
              {PROPERTY_FIELDS.map(field => {
                const raw = propDraft[field.key] ?? properties[field.key] ?? '';
                return (
                  <div className="setting-row" key={field.key}>
                    <div className="label">{field.label}<Tip text={field.tip} /></div>
                    <div className="control">
                      {field.kind === 'boolean' ? (
                        <Toggle checked={raw === 'true'} onChange={v => setPropDraft({ ...propDraft, [field.key]: String(v) })} label={field.label} />
                      ) : field.kind === 'select' ? (
                        <select className="input" style={{ width: 160 }} value={raw} onChange={e => setPropDraft({ ...propDraft, [field.key]: e.target.value })}>
                          {(field.options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (
                        <input className="input" style={{ maxWidth: 320 }} type={field.kind === 'number' ? 'number' : 'text'} value={raw} onChange={e => setPropDraft({ ...propDraft, [field.key]: e.target.value })} />
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="row mt" style={{ justifyContent: 'flex-end' }}>
                <button className="btn primary" onClick={saveProperties}>保存 server.properties</button>
              </div>
            </div>
          )}

          {tab === 'backups' && (
            <div className="mt">
              <div className="row spread">
                <p className="faint">备份会把世界文件夹（level-name）打包成 ZIP，存在服务器目录的 backups/ 下。恢复前请先停止服务器。</p>
                <button className="btn primary" disabled={busyNow} onClick={() => run('backup', () => api.serverBackup(server.id), '世界备份已创建')}>＋ 备份世界</button>
              </div>
              {backups.length === 0 ? (
                <div className="empty"><div className="big">💾</div>还没有备份</div>
              ) : (
                <div className="list mt">
                  {backups.map(b => (
                    <div key={b.name} className="list-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 650 }}>{b.name}</div>
                        <div className="faint">{formatBytes(b.sizeBytes)} · {timeAgo(b.createdAt)}</div>
                      </div>
                      <button className="btn small" disabled={busyNow} onClick={() => setRestoreTarget(b)}>恢复…</button>
                      <button className="btn small danger" onClick={() => setBackupDeleteTarget(b)}>删除</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {creating && (
        <CreateServerModal
          onClose={() => setCreating(false)}
          onCreated={async id => {
            setCreating(false);
            await reloadServers();
            setSelectedId(id);
            setTab('console');
            toast.toast('服务器已创建。点「启动服务器」会自动下载并安装服务端。', 'ok');
          }}
        />
      )}

      {eulaServer && (
        <Modal title="同意 Minecraft 服务器 EULA" onClose={() => setEulaServer(null)} footer={<>
          <button className="btn ghost" onClick={() => setEulaServer(null)}>取消</button>
          <button className="btn primary" disabled={!eulaChecked || busy === 'eula'} onClick={acceptEulaAndStart}>{busy === 'eula' ? '处理中…' : '同意并启动'}</button>
        </>}>
          <p className="muted">启动任何 Minecraft 服务器前，都必须同意 Mojang 的最终用户许可协议（EULA）。</p>
          <p className="mt">要点：不得用服务器盈利（除非符合 EULA 的商业使用条款）、不得分发游戏本体、不得逆向或修改服务端用于作弊。完整条款：</p>
          <p className="mt mono">https://aka.ms/MinecraftEULA</p>
          <label className="row mt-lg" style={{ gap: 10, cursor: 'pointer' }}>
            <input type="checkbox" checked={eulaChecked} onChange={e => setEulaChecked(e.target.checked)} />
            <span>我已阅读并同意 Minecraft EULA（会写入 eula.txt，与官方服务器一致）</span>
          </label>
          <div className="row mt" style={{ justifyContent: 'flex-end' }}>
            <button className="btn small" onClick={() => api.openExternal('https://aka.ms/MinecraftEULA')}>在浏览器打开 EULA ↗</button>
          </div>
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="删除服务器"
          message={`将删除服务器「${deleteTarget.name}」及其世界、模组、配置。\n\nMCL 会先把整个服务器目录打包到 backups/deleted-servers/，确认无误后再删除。`}
          confirmText="备份并删除"
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={doDelete}
        />
      )}

      {killTarget && (
        <ConfirmModal
          title="强制结束服务器"
          message="强制结束进程可能丢失最近几秒的世界进度（服务器来不及保存）。\n\n确定要强制结束吗？"
          confirmText="强制结束"
          danger
          onCancel={() => setKillTarget(null)}
          onConfirm={() => { const s = killTarget; setKillTarget(null); void run('kill', () => api.serverKill(s.id), '服务器进程已强制结束'); }}
        />
      )}

      {restoreTarget && server && (
        <ConfirmModal
          title="恢复世界备份"
          message={`将用备份「${restoreTarget.name}」覆盖当前世界。\n\n请确认服务器已停止。恢复前建议先手动备份当前世界。`}
          confirmText="恢复"
          danger
          onCancel={() => setRestoreTarget(null)}
          onConfirm={() => {
            const b = restoreTarget;
            setRestoreTarget(null);
            void run('restore', () => api.serverRestoreBackup(server.id, b.name), '世界已恢复');
          }}
        />
      )}

      {backupDeleteTarget && server && (
        <ConfirmModal
          title="删除世界备份"
          message={`确定删除备份「${backupDeleteTarget.name}」？此操作不可撤销。`}
          confirmText="删除"
          danger
          onCancel={() => setBackupDeleteTarget(null)}
          onConfirm={() => {
            const b = backupDeleteTarget;
            setBackupDeleteTarget(null);
            void run('deleteBackup', async () => { await api.serverDeleteBackup(server.id, b.name); }, '备份已删除');
          }}
        />
      )}
    </div>
  );
}

function CreateServerModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [versions, setVersions] = useState<Array<{ id: string; type: string }>>([]);
  const [search, setSearch] = useState('');
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [mcVersion, setMcVersion] = useState('');
  const [loader, setLoader] = useState<ServerLoader>('vanilla');
  const [loaderVersion, setLoaderVersion] = useState('');
  const [name, setName] = useState('');
  const [port, setPort] = useState(25565);
  const [memoryMB, setMemoryMB] = useState(2048);
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.versionsList().then(list => {
      setVersions(list);
      const first = list.find(v => v.type === 'release');
      if (first) setMcVersion(first.id);
    }).catch(e => toast.toast(`版本清单加载失败：${e}`, 'error'));
    /* eslint-disable-next-line */
  }, []);

  const filtered = useMemo(() => versions.filter(v =>
    (showSnapshots || v.type === 'release' || v.type === 'old_beta' || v.type === 'old_alpha') &&
    v.id.toLowerCase().includes(search.toLowerCase()),
  ).slice(0, 160), [versions, search, showSnapshots]);

  const submit = async () => {
    if (!mcVersion) { toast.toast('请选择 Minecraft 版本', 'error'); return; }
    setCreating(true);
    try {
      const config = await api.serverCreate({
        name: name.trim() || `${mcVersion}${loader !== 'vanilla' ? ` · ${loader}` : ''} 服务器`,
        mcVersion,
        loader,
        loaderVersion: loader === 'vanilla' ? null : (loaderVersion.trim() || null),
        port,
        memoryMB,
      });
      onCreated(config.id);
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally { setCreating(false); }
  };

  return (
    <Modal title="创建 Minecraft 服务器" onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>取消</button>
      <button className="btn primary" disabled={creating || !mcVersion} onClick={submit}>{creating ? '创建中…' : '创建服务器'}</button>
    </>}>
      <div className="setting-row" style={{ paddingTop: 4 }}>
        <div className="label">服务器名称<Tip text="只用于 MCL 界面显示，不影响玩家看到的 MOTD（MOTD 在 server.properties 里改）。" /></div>
        <div className="control"><input className="input" placeholder="例如：朋友联机服" value={name} onChange={e => setName(e.target.value)} /></div>
      </div>
      <div className="setting-row">
        <div className="label">Minecraft 版本<Tip text="服务端必须与玩家客户端版本一致（或兼容）。原版服务端由 Mojang 官方提供。" /></div>
        <div className="control" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <div className="row">
            <input className="input" placeholder="搜索版本，如 1.20.1" value={search} onChange={e => setSearch(e.target.value)} />
            <Toggle checked={showSnapshots} onChange={setShowSnapshots} label="显示快照" />
          </div>
          <select className="input" size={6} value={mcVersion} onChange={e => setMcVersion(e.target.value)}>
            {filtered.map(v => <option key={v.id} value={v.id}>{v.id}{v.type !== 'release' ? `（${v.type}）` : ''}</option>)}
          </select>
        </div>
      </div>
      <div className="setting-row">
        <div className="label">服务端类型<Tip text="原版最稳；Fabric/Quilt 适合轻量模组；Forge/NeoForge 适合大型模组整合包。安装器由各自官方 Maven 提供。" /></div>
        <div className="control">
          <select className="input" style={{ width: 180 }} value={loader} onChange={e => setLoader(e.target.value as ServerLoader)}>
            <option value="vanilla">原版 Vanilla</option>
            <option value="fabric">Fabric</option>
            <option value="quilt">Quilt</option>
            <option value="forge">Forge</option>
            <option value="neoforge">NeoForge</option>
          </select>
        </div>
      </div>
      {loader !== 'vanilla' && (
        <div className="setting-row">
          <div className="label">加载器版本<Tip text="留空 = 自动选择该 MC 版本下的最新版。整合包服务端请填整合包要求的版本。" /></div>
          <div className="control"><input className="input" placeholder="留空 = 最新稳定版" value={loaderVersion} onChange={e => setLoaderVersion(e.target.value)} /></div>
        </div>
      )}
      <div className="setting-row">
        <div className="label">端口<Tip text="默认 25565。如果已被占用（比如开了两个服务器），换成 25566、25567…… 记得防火墙放行。" /></div>
        <div className="control"><input className="input" style={{ width: 120 }} type="number" min={1} max={65535} value={port} onChange={e => setPort(parseInt(e.target.value, 10) || 25565)} /></div>
      </div>
      <div className="setting-row">
        <div className="label">最大内存（MB）<Tip text="原版 2G 起；模组服建议 4G–8G。不要超过电脑物理内存的一半，否则系统会频繁换页。" /></div>
        <div className="control"><input className="input" style={{ width: 130 }} type="number" min={512} max={32768} step={256} value={memoryMB} onChange={e => setMemoryMB(parseInt(e.target.value, 10) || 2048)} /></div>
      </div>
      <p className="faint mt">创建后首次点「启动服务器」时，MCL 会自动下载服务端、匹配 Java，并在需要时提示同意 EULA。安装日志会显示在控制台里。</p>
    </Modal>
  );
}