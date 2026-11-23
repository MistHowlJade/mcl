import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { Modal, Tip } from './Modal';
import type { GameOptions, InstanceInfo } from '../../electron/shared/types';

/** 给实例打标签：只做界面整理，写回 instance.json，不碰游戏文件 */
export function TagsModal({ inst, onClose, onSaved }: { inst: InstanceInfo; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState((inst.tags ?? []).join('，'));
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const PRESETS = ['生存', '创造', '整合包', '光影', 'PVP', '服务器', '测试'];

  const save = async () => {
    const tags = [...new Set(text.split(/[,，]/).map(t => t.trim().slice(0, 20)).filter(Boolean))].slice(0, 8);
    setSaving(true);
    try {
      await api.instanceUpdate(inst.id, { tags });
      toast.toast('标签已保存');
      onSaved();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={`标签 · ${inst.name}`} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={() => void save()} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
    </>}>
      <div className="setting-row">
        <div className="label">实例标签<Tip text="用逗号或中文逗号分隔，最多 8 个。标签只用于 MCL 内筛选整理，不会写进游戏配置。" /></div>
        <div className="control"><input className="input" style={{ width: '100%' }} placeholder="例如：生存，整合包，光影" value={text} onChange={e => setText(e.target.value)} autoFocus /></div>
      </div>
      <div className="faint" style={{ fontSize: 11, marginTop: 10 }}>常用标签（点击追加）</div>
      <div className="tag-filter-row" style={{ marginTop: 6 }}>
        {PRESETS.map(p => (
          <button key={p} className="tag-chip" onClick={() => setText(prev => [...new Set([...prev.split(/[,，]/).map(t => t.trim()).filter(Boolean), p])].join('，'))}>{p}</button>
        ))}
      </div>
    </Modal>
  );
}

interface OptionField {
  key: string;
  label: string;
  tip?: string;
  kind: 'select' | 'bool';
  options?: Array<[string, string]>;
  fallback: string;
}

/** 只暴露 options.txt 里最常被手改、且改错也不会让游戏崩溃的项目 */
const FIELDS: OptionField[] = [
  { key: 'renderDistance', label: '视距', tip: '区块渲染距离。数值越大越吃显卡和内存，整合包建议 8～12。', kind: 'select', fallback: '12',
    options: [['4', '4 区块'], ['6', '6 区块'], ['8', '8 区块'], ['10', '10 区块'], ['12', '12 区块'], ['16', '16 区块'], ['24', '24 区块'], ['32', '32 区块']] },
  { key: 'simulationDistance', label: '模拟距离', tip: '多少区块内的实体/方块实体会继续运作。比视距更影响性能，1.14+ 有效。', kind: 'select', fallback: '10',
    options: [['5', '5 区块'], ['8', '8 区块'], ['10', '10 区块'], ['12', '12 区块'], ['16', '16 区块']] },
  { key: 'graphicsMode', label: '画质', tip: '1.13 及以上：流畅 / 平衡 / 精细 / 极致。老版本 1.12 及以下请改用下面的「华丽图形」。', kind: 'select', fallback: '2',
    options: [['0', '流畅'], ['1', '平衡'], ['2', '精细'], ['3', '极致']] },
  { key: 'fancyGraphics', label: '华丽图形（旧版）', tip: '只影响 1.12 及以下；新版本 Minecraft 已改用上面的「画质」。', kind: 'bool', fallback: 'true' },
  { key: 'clouds', label: '云', kind: 'bool', fallback: 'true' },
  { key: 'particles', label: '粒子效果', kind: 'select', fallback: '2', options: [['0', '最少'], ['1', '减少'], ['2', '全部']] },
  { key: 'entityShadows', label: '实体阴影', tip: '关闭后生物脚下不再有阴影，能省一点 GPU。', kind: 'bool', fallback: 'true' },
  { key: 'ao', label: '环境光遮蔽', tip: '方块角落的柔和阴影，1.16+ 的选项。', kind: 'bool', fallback: 'true' },
  { key: 'guiScale', label: '界面大小', tip: '0 = 自动按窗口缩放；数字越大界面越大。', kind: 'select', fallback: '0',
    options: [['0', '自动'], ['1', '小'], ['2', '中'], ['3', '大'], ['4', '超大']] },
  { key: 'maxFps', label: '帧率上限', kind: 'select', fallback: '60', options: [['30', '30'], ['60', '60'], ['120', '120'], ['240', '240'], ['0', '不限制']] },
  { key: 'gamma', label: '亮度', kind: 'select', fallback: '1', options: [['0', '很暗'], ['0.5', '偏暗'], ['1', '正常'], ['1.5', '偏亮'], ['2', '很亮']] },
  { key: 'volume', label: '主音量', kind: 'select', fallback: '1', options: [['0', '静音'], ['0.25', '25%'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%']] },
  { key: 'musicVolume', label: '音乐音量', kind: 'select', fallback: '1', options: [['0', '静音'], ['0.25', '25%'], ['0.5', '50%'], ['0.75', '75%'], ['1', '100%']] },
  { key: 'vsync', label: '垂直同步', tip: '开启可避免画面撕裂，但会锁到显示器刷新率。', kind: 'bool', fallback: 'false' },
  { key: 'fullscreen', label: '全屏启动', kind: 'bool', fallback: 'false' },
];

/** 图形化编辑 options.txt：写盘白名单在主进程，这里只负责取值与拼写 */
export function GameOptionsModal({ inst, onClose }: { inst: InstanceInfo; onClose: () => void }) {
  const [values, setValues] = useState<GameOptions>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api.gameOptionsRead(inst.id).then(setValues).catch(e => toast.toast(String(e), 'error')).finally(() => setLoading(false));
    /* eslint-disable-next-line */
  }, [inst.id]);

  const save = async () => {
    setSaving(true);
    try {
      await api.gameOptionsSave(inst.id, values);
      toast.toast('游戏设置已写入 options.txt，下次启动生效');
      onClose();
    } catch (e) { toast.toast(e instanceof Error ? e.message : String(e), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <Modal title={`游戏设置 · ${inst.name}`} onClose={onClose} wide footer={<>
      <button className="btn ghost" onClick={onClose}>取消</button>
      <button className="btn primary" onClick={() => void save()} disabled={saving || loading}>{saving ? '保存中…' : '保存设置'}</button>
    </>}>
      <div className="options-note">这里改的是 Minecraft 自己的 options.txt。游戏运行时不能修改，否则退出时会被游戏覆盖；只显示常用项，其余高级参数仍可手改配置文件。</div>
      {loading ? <div className="faint" style={{ padding: 20 }}>正在读取当前设置…</div> : (
        <div className="options-grid">
          {FIELDS.map(field => {
            const current = values[field.key] ?? field.fallback;
            return (
              <div key={field.key} className="setting-row options-field">
                <div className="label">{field.label}{field.tip && <Tip text={field.tip} />}</div>
                <div className="control">
                  {field.kind === 'bool' ? (
                    <select className="input" value={String(current) === 'true' ? 'true' : 'false'} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))}>
                      <option value="true">开启</option><option value="false">关闭</option>
                    </select>
                  ) : (
                    <select className="input" value={String(current)} onChange={e => setValues(v => ({ ...v, [field.key]: e.target.value }))}>
                      {(field.options ?? []).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                      {values[field.key] && !(field.options ?? []).some(([value]) => value === String(current)) && (
                        <option value={String(current)}>当前值：{String(current)}</option>
                      )}
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
