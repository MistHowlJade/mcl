import React from 'react';
import { Icon } from './Icon';

/** 统一空状态：标题 + 说明 + 可选主操作，避免每个页面手写一套 */
export function EmptyState({ icon, title, description, action }: {
  icon: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="big"><Icon name={icon} size={32} /></div>
      <div style={{ fontWeight: 700, color: 'var(--text)' }}>{title}</div>
      {description && <div className="faint mt">{description}</div>}
      {action && <div className="row mt-lg" style={{ justifyContent: 'center' }}>{action}</div>}
    </div>
  );
}

/** 首屏加载骨架，替代纯文字“正在加载…” */
export function Skeleton({ height = 16, width, radius }: { height?: number | string; width?: number | string; radius?: number }) {
  return <div className="skeleton" style={{ height, width, borderRadius: radius ?? 7 }} />;
}

export function PageSkeleton() {
  return (
    <div>
      <Skeleton height={86} radius={10} />
      <div className="home-stats">
        {[0, 1, 2, 3].map(i => <div key={i} className="panel"><Skeleton height={48} /></div>)}
      </div>
      <div className="panel mt-lg">
        <Skeleton height={20} width={160} />
        <div className="mt"><Skeleton height={40} /></div>
        <div className="mt"><Skeleton height={40} /></div>
        <div className="mt"><Skeleton height={40} /></div>
      </div>
    </div>
  );
}
