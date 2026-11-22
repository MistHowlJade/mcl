import React, { useEffect, useRef } from 'react';

export interface VersionOption {
  id: string;
  type: string;
  releaseTime?: string;
}

const TYPE_LABEL: Record<string, string> = {
  release: '正式版',
  snapshot: '快照',
  old_beta: '旧版 Beta',
  old_alpha: '旧版 Alpha',
};

/**
 * 自定义版本列表（替代原生 <select size>）。
 * 原生列表框在 Windows 上是浅色系统控件，且选中项不够明显；PCL2/HMCL 的版本选择
 * 都是“整行高亮 + 类型/日期辅助信息”，这里按同样习惯实现，支持方向键与首尾跳转。
 */
export function VersionList({ options, selected, onSelect, loading, disabled, loadingText, emptyText, label }: {
  options: VersionOption[];
  selected: string;
  onSelect: (id: string) => void;
  loading?: boolean;
  disabled?: boolean;
  loadingText?: string;
  emptyText?: string;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex(v => v.id === selected);

  // 选中项变化（包括搜索过滤后自动切换）时，保证它在可视区域内
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.version-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected, options.length]);

  const step = (delta: number) => {
    if (disabled || options.length === 0) return;
    const base = selectedIndex < 0 ? 0 : selectedIndex;
    const next = Math.min(options.length - 1, Math.max(0, base + delta));
    onSelect(options[next].id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Home') { e.preventDefault(); if (options[0]) onSelect(options[0].id); }
    else if (e.key === 'End') { e.preventDefault(); if (options.length) onSelect(options[options.length - 1].id); }
  };

  return (
    <div
      className={`version-list ${disabled ? 'disabled' : ''}`}
      role="listbox"
      aria-label={label ?? 'Minecraft 版本'}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      ref={ref}
      onKeyDown={onKeyDown}
    >
      {loading && <div className="version-empty">{loadingText ?? '正在加载版本清单…'}</div>}
      {!loading && options.length === 0 && <div className="version-empty">{emptyText ?? '没有匹配的版本'}</div>}
      {!loading && options.map(v => (
        <button
          type="button"
          key={v.id}
          className={`version-item ${v.id === selected ? 'selected' : ''}`}
          role="option"
          aria-selected={v.id === selected}
          tabIndex={-1}
          onClick={() => onSelect(v.id)}
        >
          <span className="vid">{v.id}</span>
          {v.releaseTime && <span className="vdate">{v.releaseTime.slice(0, 10)}</span>}
          <span className="vtype">{TYPE_LABEL[v.type] ?? v.type}</span>
        </button>
      ))}
    </div>
  );
}
