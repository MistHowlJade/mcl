import React, { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Modal } from '../components/Modal';
import { FavoriteButton, useFavorites } from '../components/FavoriteButton';
import { Icon } from '../components/Icon';
import { useInstanceSelection } from '../lib/hooks';
import type { ModSearchResult } from '../../electron/shared/types';

type DownloadKind = 'modpack' | 'resourcepack' | 'shader' | 'world';

const TABS: Array<{ id: DownloadKind; label: string; icon: string; hint: string }> = [
  { id: 'modpack', label: '整合包', icon: 'box', hint: '从 Modrinth 搜索整合包，下载后自动导入为新实例（与原实例隔离）。' },
  { id: 'resourcepack', label: '资源包', icon: 'palette', hint: '下载后直接放入所选实例的 resourcepacks 目录，可在「内容管理」里启用。' },
  { id: 'shader', label: '光影包', icon: 'shader', hint: '下载后放入所选实例的 shaderpacks 目录，需要 Iris / OptiFine 才能生效。' },
  { id: 'world', label: '地图 / 世界', icon: 'globe', hint: '下载后自动解压到所选实例的 saves 目录，ZIP 内嵌目录会自动识别。' },
];

const KIND_TO_INSTALL: Record<DownloadKind, 'modpack' | 'resourcepacks' | 'shaderpacks' | 'worlds'> = {
  modpack: 'modpack',
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
  world: 'worlds',
};

export default function Download() {
  const { instances, instanceId, setInstanceId } = useInstanceSelection();
  const instance = instances.find(i => i.id === instanceId) ?? null;
  const { ids: favoriteIds } = useFavorites();
  const toast = useToast();

  const [kind, setKind] = useState<DownloadKind>('modpack');
  const [query, setQuery] = useState('');
  const [gameVersion, setGameVersion] = useState('');
  const [results, setResults] = useState<ModSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [onlyFavorites, setOnlyFavorites] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const searchSeq = useRef(0);

  const current = TABS.find(t => t.id === kind)!;
  const loader = instance && instance.loader !== 'vanilla' ? instance.loader : undefined;

  const doSearch = async (q: string, gv: string) => {
    const seq = ++searchSeq.current;
    setSearching(true);
    setError(null);
    try {
      const list = await api.modrinthSearchContent(q.trim(), {
        projectType: kind,
        gameVersion: gv.trim() || undefined,
        loader: kind === 'modpack' ? loader : undefined,
        index: q.trim() ? 'relevance' : 'downloads',
        limit: 30,
      });
      if (seq !== searchSeq.current) return;
      setResults(list);
      if (list.length === 0) setError('没有找到匹配的内容。试试换个关键词，或清空游戏版本过滤。');
    } catch (e) {
      if (seq !== searchSeq.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setResults([]);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  };

  // 首次进入或切换分类 / 实例时，按当前 MC 版本浏览热门内容
  useEffect(() => {
    const version = instance?.mcVersion && instance.mcVersion !== 'unknown' ? instance.mcVersion : '';
    setGameVersion(version);
    void doSearch('', version);
    /* eslint-disable-next-line */
  }, [kind, instanceId]);

  const install = async (item: ModSearchResult) => {
    if (kind !== 'modpack' && !instanceId) {
      toast.toast('请先选择一个实例作为安装目标', 'error');
      return;
    }
    setInstallingId(item.projectId);
    try {
      const result = await api.modrinthInstallContent(
        kind === 'modpack' ? '' : instanceId!,
        item.projectId,
        null,
        KIND_TO_INSTALL[kind],
        {
          gameVersion: gameVersion.trim() || undefined,
          loader: kind === 'modpack' ? loader : undefined,
          name: item.title,
        },
      );
      if (kind === 'modpack') {
        toast.toast(result.instanceId ? `整合包已导入为新实例，可在「实例」页看到` : '整合包已下载并开始导入', 'ok');
        if (result.warnings?.length) setWarnings(result.warnings);
      } else if (kind === 'world') {
        toast.toast(`地图已安装：${result.worldName ?? result.fileName}`, 'ok');
      } else {
        toast.toast(`已安装：${result.fileName}`, 'ok');
      }
    } catch (e) {
      toast.toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setInstallingId(null);
    }
  };

  const shown = onlyFavorites ? results.filter(item => favoriteIds.includes(item.projectId)) : results;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>资源下载</h1>
          <div className="sub">整合包、资源包、光影包、地图世界——从 Modrinth 直接搜索并下载</div>
        </div>
        <span className="tag blue">数据源：Modrinth</span>
      </div>

      <div className="panel">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {TABS.map(tab => (
            <button key={tab.id} className={`btn ${kind === tab.id ? 'primary' : ''}`} onClick={() => setKind(tab.id)}>
              <Icon name={tab.icon} size={14} /> {tab.label}
            </button>
          ))}
        </div>
        <p className="faint mt">{current.hint}</p>

        <div className="row mt" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 220 }}
            placeholder={`搜索${current.label}，留空 = 按下载量浏览热门`}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void doSearch(query, gameVersion)}
          />
          <input className="input" style={{ width: 130 }} placeholder="游戏版本" value={gameVersion} onChange={e => setGameVersion(e.target.value)} />
          <button className="btn primary" onClick={() => void doSearch(query, gameVersion)} disabled={searching}>{searching ? '搜索中…' : '搜索'}</button>
          <button className={`btn small ${onlyFavorites ? 'primary' : ''}`} onClick={() => setOnlyFavorites(v => !v)} title="只看收藏的资源"><Icon name="star" size={12} /> 只看收藏</button>
        </div>

        {kind === 'modpack' ? (
          <div className="faint mt">安装整合包会创建一个<b>全新实例</b>，不会改动当前选中的「{instance?.name ?? '—'}」。</div>
        ) : (
          <div className="row mt" style={{ gap: 8 }}>
            <span className="faint">安装到实例</span>
            <select className="input" style={{ width: 260 }} value={instanceId ?? ''} onChange={e => setInstanceId(e.target.value)}>
              {instances.map(i => <option key={i.id} value={i.id}>{i.name}（{i.mcVersion} {i.loader}）</option>)}
            </select>
            {instance && <span className="tag">MC {instance.mcVersion}</span>}
          </div>
        )}
      </div>

      {searching && <div className="empty panel"><div className="big">⏳</div>正在向 Modrinth 查询…</div>}
      {!searching && error && <div className="empty panel">{error}</div>}
      {!searching && !error && (
        <div className="panel mt">
          <div className="list">
            {shown.map(item => (
              <div key={item.projectId} className="list-row" style={{ alignItems: 'flex-start' }}>
                <div style={{ width: 46, height: 46, borderRadius: 9, background: 'var(--panel-3)', overflow: 'hidden', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                  {item.iconUrl ? <img src={item.iconUrl} alt="" style={{ width: 46, height: 46, objectFit: 'cover' }} /> : <Icon name="box" size={20} />}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <strong>{item.title}</strong>
                    <span className="tag">{item.author || '未知作者'}</span>
                    {gameVersion.trim() && item.gameVersions.includes(gameVersion.trim()) && <span className="tag green">兼容 {gameVersion.trim()}</span>}
                  </div>
                  <div className="faint" style={{ marginTop: 2 }}>{item.description}</div>
                  <div className="faint" style={{ marginTop: 4 }}>
                    ⬇ {item.downloads.toLocaleString()} · ❤ {item.follows.toLocaleString()}
                    {item.gameVersions.length > 0 && ` · 支持 ${item.gameVersions.slice(-4).join(' / ')}`}
                    {item.loaders.length > 0 && ` · ${item.loaders.slice(0, 4).join(' / ')}`}
                  </div>
                </div>
                <div className="row" style={{ gap: 6, flexShrink: 0 }}>
                  <FavoriteButton id={item.projectId} />
                  <button className="btn small" onClick={() => api.openExternal(`https://modrinth.com/project/${item.slug}`).catch(e => toast.toast(String(e), 'error'))}>详情 ↗</button>
                  <button className="btn small primary" onClick={() => void install(item)} disabled={installingId !== null}>
                    {installingId === item.projectId ? '安装中…' : '下载'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {warnings && (
        <Modal title="导入提示" onClose={() => setWarnings(null)} footer={<button className="btn primary" onClick={() => setWarnings(null)}>知道了</button>}>
          <ul className="muted" style={{ paddingLeft: 18, lineHeight: 1.9 }}>
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Modal>
      )}
    </div>
  );
}
