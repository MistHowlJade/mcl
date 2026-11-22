import React from 'react';

/**
 * 统一线性图标：24×24 viewBox、1.7px 描边、currentColor。
 * 用 SVG 替换所有 emoji，避免不同系统字体渲染不一致，提升整体质感。
 */
const PATHS: Record<string, React.ReactNode> = {
  box: <><path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z" /><path d="m3 7.5 9 4.5 9-4.5M12 12v9" /></>,
  save: <><ellipse cx="12" cy="5.5" rx="8" ry="2.8" /><path d="M4 5.5v13c0 1.55 3.58 2.8 8 2.8s8-1.25 8-2.8v-13" /><path d="M4 12c0 1.55 3.58 2.8 8 2.8s8-1.25 8-2.8" /></>,
  puzzle: <><path d="M10 3h4v2.2a1.8 1.8 0 1 0 3.6 0V3H21v5h-2.2a1.8 1.8 0 1 0 0 3.6H21v7h-5v-2.2a1.8 1.8 0 1 0-3.6 0V18H6v-5h2.2a1.8 1.8 0 1 0 0-3.6H6V3h4Z" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18h1.2a1.8 1.8 0 0 0 0-3.6H12a1.6 1.6 0 0 1 0-3.2h1.6a6.4 6.4 0 0 0 0-12.8H12Z" /><circle cx="7.5" cy="11" r=".9" fill="currentColor" stroke="none" /><circle cx="10.5" cy="7.5" r=".9" fill="currentColor" stroke="none" /><circle cx="15" cy="8" r=".9" fill="currentColor" stroke="none" /></>,
  shader: <><path d="M3 18h18M5.5 15a6.5 6.5 0 0 1 13 0" /><path d="M12 4v2M4.7 7.2l1.4 1.4M19.3 7.2l-1.4 1.4" /><circle cx="12" cy="14" r="2" /></>,
  camera: <><path d="M4 7h3l1.5-2h7L17 7h3v12H4V7Z" /><circle cx="12" cy="12.5" r="3.2" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" /></>,
  server: <><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" /></>,
  cloud: <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5 4.5 4.5 0 0 1 17.5 18H7Z" />,
  health: <><path d="M20.5 8.5c0 4.2-8.5 10-8.5 10S3.5 12.7 3.5 8.5a4.5 4.5 0 0 1 8.5-2 4.5 4.5 0 0 1 8.5 2Z" /><path d="M4.5 12h4l1.5-2.5 2 5 1.5-2.5h5" /></>,
  migrate: <><path d="M3 12h14M13 6l6 6-6 6" /><rect x="3" y="9" width="5" height="6" rx="1" /></>,
  folder: <path d="M3 6h6l2 2h10v11H3V6Z" />,
  folderTree: <><rect x="3" y="4" width="7" height="6" rx="1.5" /><rect x="14" y="14" width="7" height="6" rx="1.5" /><path d="M6.5 10v6a2 2 0 0 0 2 2H14" /></>,
  broom: <><path d="m14 3 7 7M13 8l3 3-7 7-3-3 7-7Z" /><path d="m9 15-4 4 1 2 6-1" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5.5l3.5 2" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></>,
  disk: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="12" cy="12" r="3.5" /><path d="M7 8h.01" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>,
  play: <path d="M8 5.5 19 12 8 18.5v-13Z" fill="currentColor" stroke="none" />,
  bolt: <path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />,
  cog: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z" />,
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  warn: <><path d="M12 3 2.5 20h19L12 3Z" /><path d="M12 10v4M12 17h.01" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  shield: <path d="M12 3 4 6v6c0 5 3.4 8.4 8 9 4.6-.6 8-4 8-9V6l-8-3Z" />,
};

export function Icon({ name, size = 16, className = '' }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={`ui-icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name] ?? PATHS.box}
    </svg>
  );
}

export default Icon;
