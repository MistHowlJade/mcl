import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { Icon } from '../components/Icon';
import { EmptyState } from '../components/ui';
import { useInstanceSelection } from '../lib/hooks';
import type { LaunchPreview as LaunchPreviewData } from '../../electron/shared/types';

export default function LaunchPreview() {
  const { instances, instanceId, setInstanceId } = useInstanceSelection();
  const [preview, setPreview] = useState<LaunchPreviewData | null>(null);
  const [loading, setLoading] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (!instanceId) { setPreview(null); return; }
    setLoading(true);
    api.launchPreview(instanceId).then(setPreview)
      .catch(e => toast.toast(String(e), 'error'))
      .finally(() => setLoading(false));
    /* eslint-disable-next-line */
  }, [instanceId]);

  const copy = async () => {
    if (!preview) return;
    try {
      const ok = await api.copyText(preview.command);
      toast.toast(ok ? '启动命令已复制到剪贴板' : '复制失败', ok ? 'ok' : 'error');
    } catch (e) { toast.toast(String(e), 'error'); }
  };

  if (instances.length === 0) return <EmptyState icon="terminal" title="还没有实例" description="先创建一个实例，才能预览它的启动参数。" />;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>启动参数预览</h1>
          <div className="sub">把内存、GC、编码、代理和自定义 JVM 参数逐条摊开，附人话解释；classpath 与游戏参数在启动时自动展开。</div>
        </div>
        <div className="row">
          <select className="input" style={{ width: 'auto' }} value={instanceId ?? ''} onChange={e => setInstanceId(e.target.value)}>
            {instances.map(i => <option key={i.id} value={i.id}>{i.name}（{i.mcVersion} {i.loader}）</option>)}
          </select>
          <button className="btn" onClick={copy} disabled={!preview}>复制命令</button>
        </div>
      </div>

      {loading || !preview ? (
        <div className="empty"><div className="big"><Icon name="terminal" size={30} /></div>正在生成启动参数预览…</div>
      ) : (
        <>
          <div className="grid cols-2">
            <div className="panel">
              <div className="panel-title">运行环境</div>
              <div className="row spread"><span className="faint">实例</span><strong>{preview.instanceName}</strong></div>
              <div className="row spread" style={{ marginTop: 8 }}><span className="faint">Java</span><strong className="mono" style={{ fontSize: 11 }}>{preview.javaPath || `未找到 Java ${preview.recommendedJavaMajor}+`}</strong></div>
              <div className="row spread" style={{ marginTop: 8 }}><span className="faint">推荐版本</span><span className="tag blue">Java {preview.recommendedJavaMajor}+</span></div>
              <div className="row spread" style={{ marginTop: 8 }}><span className="faint">内存</span><strong>{preview.memory.initial} → {preview.memory.max} · {preview.memory.label}</strong></div>
            </div>

            <div className="panel">
              <div className="panel-title">参数分组（{preview.groups.length}）</div>
              {preview.groups.map((item, index) => (
                <div key={item.id} style={{ marginBottom: 10 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="tag">{index + 1}</span>
                    <strong style={{ fontSize: 12 }}>{item.label}</strong>
                    <span className="faint">{item.args.length} 项</span>
                  </div>
                  <div className="faint" style={{ marginTop: 3, lineHeight: 1.6 }}>{item.explain}</div>
                  <div className="mono" style={{ marginTop: 4, fontSize: 10.5, color: 'var(--accent)', wordBreak: 'break-all' }}>{item.args.join(' ')}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel" style={{ marginTop: 12 }}>
            <div className="panel-title">命令预览</div>
            <pre className="mono" style={{ margin: 0, padding: 12, background: 'var(--panel-2)', borderRadius: 8, fontSize: 11, lineHeight: 1.8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{preview.command}</pre>
            <div className="faint" style={{ marginTop: 10, lineHeight: 1.8 }}>
              {preview.notes.map((note, i) => <div key={i}>· {note}</div>)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
