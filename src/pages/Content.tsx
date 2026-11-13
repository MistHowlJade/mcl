import React, { useEffect, useMemo, useState } from 'react';
import { api, mediaUrl } from '../lib/api';
import { useToast } from '../components/Toast';
import { ConfirmModal, Modal, formatBytes, timeAgo } from '../components/Modal';
import type { ContentItem, ContentKind, ContentList, InstanceInfo, ModSearchResult } from '../../electron/shared/types';

const TABS: Array<{ id: ContentKind; label: string; icon: string; empty: string; tip: string }> = [
  { id: 'resourcepacks', label: '资源包', icon: '🎨', empty: '还没有资源包。把 ZIP 拖进来或点「导入 ZIP」。', tip: '资源包会改变材质、声音与界面。启用状态直接写入 options.txt，进游戏立即生效。' },
  { id: 'shaderpacks', label: '光影包', icon: '🌅', empty: '还没有光影包。需要安装 Iris / OptiFine 才能使用。', tip: '光影开关会同时写入 iris.properties 与 optionsshaders.txt，Iris 和 OptiFine 都能识别。' },
  { id: 'screenshots', label: '截图', icon: '📸', empty: '还没有截图。游戏里按 F2 截图，会自动出现在这里。', tip: '截图直接从实例的 screenshots 目录读取，不会上传到任何服务器。' },
  { id: 'worlds', label: '世界', icon: '🌍', empty: '还没有世界。创建世界后会出现在这里。', tip: '删除世界前会自动打包到该实例的备份目录，后悔了可以去「存档备份」恢复。' },
];

export default function Content() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [instanceId, setInstanceId] = useState<string | null>(() => localStorage.getItem('mcl:selectedInstance'));
  const [content, setContent] = useState<ContentList | null>(null);
  const [tab, setTab] = useState<ContentKind>('resourcepacks');
  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: ContentKind; item: ContentItem } | null>(null);
  const [onlineOpen, setOnlineOpen] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.instancesList().then(list => {
      setInstances(list);
      if (!instanceId && list.length) setInstanceId(list[0].id);
    }).catch(e => toast.toast(String(e), 'error'));
    /* eslint-disable-next-line */
  }, []);

  useEffect(() => {
    if (instanceId) localStorage.setItem('mcl:selectedInstance', instanceId);
  }, [instanceId]);

  const reload = async () => {
    if (!instanceId) return;
    setLoading(true);
    try { setContent(await api.contentList(instanceId)); }
    catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [instanceId]);

  const instance = useMemo(() => instances.find(i => i.id === instanceId) ?? null, [instances, instanceId]);
  const items = content?.[tab] ?? [];
  const currentTab = TABS.find(t => t.id === tab)!;

  const toggle = async (item: ContentItem) => {
    if (!instanceId) return;
    try {
      const now = tab === 'resourcepacks'
        ? await api.contentToggleResourcePack(instanceId, item.fileName)
        : await api.contentToggleShaderPack(instanceId, item.fileName);
      toast.toast(now ? `已启用 ${item.name}` : `已停用 ${item.name}`, 'ok');
      void reload();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const importItem = async (mode: 'file' | 'folder') => {
    if (!instanceId) return;
    try {
      const result = await api.contentImportDialog(instanceId, tab, mode);
      if (!result) return;
      toast.toast(result.imported > 0
        ? `已导入 ${result.imported} 项${result.skipped.length ? `，${result.skipped.length} 项被跳过` : ''}`
        : '没有可导入的内容', result.imported > 0 ? 'ok' : 'info');
      void reload();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const doDelete = async () => {
    if (!deleteTarget || !instanceId) return;
    try {
      const r = await api.contentDelete(instanceId, deleteTarget.kind, deleteTarget.item.fileName);
      toast.toast(r.deleted
        ? (r.backupPath ? '已删除；删除前已自动备份到该实例的备份目录' : '已删除')
        : '内容不存在，可能已被手动删除', r.deleted ? 'ok' : 'info');
      setDeleteTarget(null);
      void reload();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const backupWorld = async (item: ContentItem) => {
    if (!instanceId) return;
    try {
      const p = await api.contentBackupWorld(instanceId, item.fileName, `世界备份：${item.name}`);
      toast.toast(`世界已备份：${p}`, 'ok');
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  const exportWorld = async (item: ContentItem) => {
    if (!instanceId) return;
    try {
      const r = await api.contentExportWorld(instanceId, item.fileName);
      if (r) toast.toast(`世界已导出为 ZIP：${r.filePath}（${formatBytes(r.sizeBytes)}）`, 'ok');
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
  };

  if (instances.length === 0) {
    return (
      <div>
        <div className="page-header"><div><h1>内容管理</h1><div className="sub">资源包 / 光影 / 截图 / 世界，一个页面全管</div></div></div>
        <div className="empty"><div className="big">🎨</div>先创建一个实例，再回来管理它的资源包、光影和世界</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>内容管理</h1>
          <div className="sub">资源包 / 光影 / 截图 / 世界都在实例自己的目录里，互不串味</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select className="input" style={{ width: 220 }} value={instanceId ?? ''} onChange={e => setInstanceId(e.target.value)}>
            {instances.map(i => <option key={i.id} value={i.id}>{i.name}（{i.mcVersion}）</option>)}
          </select>
          <button className="btn" onClick={() => instanceId && api.contentOpenFolder(instanceId, tab)}>打开文件夹</button>
        </div>
      </div>

      <div className="panel">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {TABS.map(t => (
            <button
              key={t.id}
              className={`btn ${tab === t.id ? 'primary' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon} {t.label}
              <span className="tag" style={{ marginLeft: 6 }}>{content?.[t.id].length ?? 0}</span>
            </button>
          ))}
          <span className="spacer" style={{ flex: 1 }} />
          {(tab === 'resourcepacks' || tab === 'shaderpacks' || tab === 'worlds') && (
            <button className="btn primary" onClick={() => setOnlineOpen(true)} disabled={!instanceId}>
              ☁️ 在线下载
            </button>
          )}
          {tab === 'worlds' ? (
            <>
              <button className="btn" onClick={() => importItem('folder')} disabled={!instanceId}>＋ 导入世界文件夹</button>
              <button className="btn" onClick={() => importItem('file')} disabled={!instanceId}>＋ 导入世界 ZIP</button>
            </>
          ) : tab === 'screenshots' ? (
            <button className="btn" onClick={() => importItem('file')} disabled={!instanceId}>＋ 导入图片</button>
          ) : (
            <>
              <button className="btn" onClick={() => importItem('file')} disabled={!instanceId}>＋ 导入 ZIP</button>
              <button className="btn" onClick={() => importItem('folder')} disabled={!instanceId}>＋ 导入文件夹</button>
            </>
          )}
        </div>
        <p className="faint mt">{currentTab.tip}</p>
      </div>

      {loading && !content ? (
        <div className="empty"><div className="big">⏳</div>正在读取内容…</div>
      ) : items.length === 0 ? (
        <div className="empty">
          <div className="big">{currentTab.icon}</div>
          {currentTab.empty}
          <div className="row mt" style={{ justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => importItem(tab === 'worlds' ? 'folder' : 'file')}>导入到「{instance?.name}」</button>
          </div>
        </div>
      ) : tab === 'screenshots' ? (
        <div className="grid cols-3">
          {items.map(item => (
            <div key={item.fileName} className="panel" style={{ padding: 10 }}>
              <div
                style={{ borderRadius: 8, overflow: 'hidden', background: '#0b0e14', aspectRatio: '16 / 9', display: 'grid', placeItems: 'center', cursor: 'pointer' }}
                onClick={() => api.contentOpenItem(item.path)}
                title="点击用系统看图工具打开"
              >
                <img src={mediaUrl(item.previewPath)} alt={item.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </div>
              <div className="row spread mt" style={{ gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.name}>{item.name}</div>
                  <div className="faint">{formatBytes(item.sizeBytes)} · {timeAgo(item.mtime)}</div>
                </div>
                <button className="btn small danger" onClick={() => setDeleteTarget({ kind: tab, item })}>删除</button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel">
          <div className="list">
            {items.map(item => (
              <div key={item.fileName} className="list-row">
                <div style={{ width: 42, height: 42, borderRadius: 9, background: 'var(--panel-3)', display: 'grid', placeItems: 'center', fontSize: 20, flexShrink: 0, overflow: 'hidden' }}>
                  {tab === 'worlds' && item.previewPath
                    ? <img src={mediaUrl(item.previewPath)} alt="" style={{ width: 42, height: 42, objectFit: 'cover', imageRendering: 'pixelated' }} />
                    : currentTab.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</strong>
                    {(tab === 'resourcepacks' || tab === 'shaderpacks') && (
                      <span className={`tag ${item.enabled ? 'green' : ''}`}>{item.enabled ? '已启用' : '未启用'}</span>
                    )}
                  </div>
                  <div className="faint">{formatBytes(item.sizeBytes)} · {timeAgo(item.mtime)} · {item.fileName}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  {(tab === 'resourcepacks' || tab === 'shaderpacks') && (
                    <button className="btn small" onClick={() => toggle(item)}>{item.enabled ? '停用' : '启用'}</button>
                  )}
                  {tab === 'worlds' && (
                    <>
                      <button className="btn small" onClick={() => backupWorld(item)}>备份世界</button>
                      <button className="btn small" onClick={() => exportWorld(item)}>导出 ZIP</button>
                      <button className="btn small" onClick={() => api.contentOpenItem(item.path)}>打开</button>
                    </>
                  )}
                  <button className="btn small danger" onClick={() => setDeleteTarget({ kind: tab, item })}>删除</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {onlineOpen && instance && (tab === 'resourcepacks' || tab === 'shaderpacks' || tab === 'worlds') && (
        <OnlineContentModal
          instance={instance}
          kind={tab}
          onClose={() => setOnlineOpen(false)}
          onInstalled={() => { setOnlineOpen(false); void reload(); }}
        />
      )}

      {deleteTarget && (
        <ConfirmModal
          title={`删除${TABS.find(t => t.id === deleteTarget.kind)?.label ?? '内容'}`}
          message={deleteTarget.kind === 'worlds'
            ? `将删除世界「${deleteTarget.item.name}」，并先自动打包到该实例的备份目录（可在「存档备份」恢复）。\n\n确定继续？`
            : `确定删除「${deleteTarget.item.name}」？此操作不可撤销。`}
          confirmText={deleteTarget.kind === 'worlds' ? '备份并删除' : '删除'}
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={doDelete}
        />
      )}
    </div>
  );
}

const ONLINE_KIND_INFO: Record<'resourcepacks' | 'shaderpacks' | 'worlds', { projectType: 'resourcepack' | 'shader' | 'world'; label: string; hint: string }> = {
  resourcepacks: { projectType: 'resourcepack', label: '资源包', hint: '来自 Modrinth，下载后直接放进实例的 resourcepacks 目录，可在列表里启用。' },
  shaderpacks: { projectType: 'shader', label: '光影包', hint: '来自 Modrinth。需要实例已安装 Iris 或 OptiFine 才能生效。' },
  worlds: { projectType: 'world', label: '世界', hint: '来自 Modrinth。下载后自动解压到实例的 saves 目录（ZIP 内嵌目录会自动识别）。' },
};

function OnlineContentModal({ instance, kind, onClose, onInstalled }: {
  instance: InstanceInfo;
  kind: 'resourcepacks' | 'shaderpacks' | 'worlds';
  onClose: () => void;
  onInstalled: () => void;
}) {
  const info = ONLINE_KIND_INFO[kind];
  const [query, setQuery] = useState('');
  const [gameVersion, setGameVersion] = useState(instance.mcVersion === 'unknown' ? '' : instance.mcVersion);
  const [results, setResults] = useState<ModSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const search = async (q: string, gv: string) => {
    setSearching(true);
    setError(null);
    try {
      const list = await api.modrinthSearchContent(q, {
        projectType: info.projectType,
        gameVersion: gv.trim() || undefined,
        index: q.trim() ? 'relevance' : 'downloads',
        limit: 30,
      });
      setResults(list);
      if (list.length === 0) setError('没有找到匹配的内容。试试换个关键词，或清空游戏版本过滤。');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults([]);
    } finally { setSearching(false); }
  };

  useEffect(() => { void search('', instance.mcVersion === 'unknown' ? '' : instance.mcVersion); /* eslint-disable-next-line */ }, []);

  const install = async (item: ModSearchResult) => {
    setInstallingId(item.projectId);
    try {
      const r = await api.modrinthInstallContent(instance.id, item.projectId, null, kind, {
        gameVersion: gameVersion.trim() || undefined,
        loader: instance.loader,
      });
      toast.toast(kind === 'worlds'
        ? `世界已安装：${r.worldName ?? r.fileName}（可在世界列表看到）`
        : `已安装 ${r.fileName}（${formatBytes(r.sizeBytes)}）`, 'ok');
      onInstalled();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setInstallingId(null); }
  };

  return (
    <Modal title={`在线下载${info.label}`} onClose={onClose} footer={<button className="btn ghost" onClick={onClose}>关闭</button>}>
      <p className="faint" style={{ marginTop: 0 }}>{info.hint}</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 220 }}
          placeholder={`搜索${info.label}，留空 = 按下载量浏览热门`}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void search(query, gameVersion)}
        />
        <input className="input" style={{ width: 120 }} placeholder="游戏版本" value={gameVersion} onChange={e => setGameVersion(e.target.value)} />
        <button className="btn primary" onClick={() => void search(query, gameVersion)} disabled={searching}>{searching ? '搜索中…' : '搜索'}</button>
      </div>
      <div className="faint mt">目标实例：{instance.name} · {instance.mcVersion} · {instance.loader}</div>

      {searching && <div className="empty" style={{ padding: 30 }}><div className="big">⏳</div>正在向 Modrinth 查询…</div>}
      {!searching && error && <div className="empty" style={{ padding: 26 }}>{error}</div>}
      {!searching && !error && (
        <div className="list mt" style={{ maxHeight: 430, overflowY: 'auto' }}>
          {results.map(item => (
            <div key={item.projectId} className="list-row" style={{ alignItems: 'flex-start' }}>
              <div style={{ width: 42, height: 42, borderRadius: 9, background: 'var(--panel-3)', overflow: 'hidden', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                {item.iconUrl ? <img src={item.iconUrl} alt="" style={{ width: 42, height: 42, objectFit: 'cover' }} /> : '📦'}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                  <strong>{item.title}</strong>
                  <span className="tag">{item.author || '未知作者'}</span>
                  {item.gameVersions.includes(gameVersion) && <span className="tag green">兼容 {gameVersion}</span>}
                </div>
                <div className="faint" style={{ marginTop: 2 }}>{item.description}</div>
                <div className="faint" style={{ marginTop: 4 }}>
                  ⬇ {item.downloads.toLocaleString()} · ❤ {item.follows.toLocaleString()}
                  {item.gameVersions.length > 0 && ` · 支持 ${item.gameVersions.slice(-4).join(' / ')}`}
                </div>
              </div>
              <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                <button className="btn small" onClick={() => api.openExternal(`https://modrinth.com/project/${item.slug}`)}>详情 ↗</button>
                <button className="btn small primary" onClick={() => install(item)} disabled={installingId !== null}>
                  {installingId === item.projectId ? '安装中…' : '安装'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}