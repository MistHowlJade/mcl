import React, { useId } from 'react';

/**
 * 柔光玻璃方块：启动台主视觉。
 * 等距三面玻璃立方体用 SVG 画出来，颜色走 CSS 变量，明暗主题共用一套构图。
 */
export function GlassCube({ className = '' }: { className?: string }) {
  const raw = useId();
  const uid = raw.replace(/[^a-zA-Z0-9_-]/g, '');
  const top = `cubeTop-${uid}`;
  const left = `cubeLeft-${uid}`;
  const right = `cubeRight-${uid}`;
  const sheen = `cubeSheen-${uid}`;

  return (
    <div className={`glass-cube-wrap ${className}`} aria-hidden="true">
      <span className="cube-aura" />
      <span className="cube-shadow" />
      <span className="cube-orbit" />
      <svg className="cube-svg" viewBox="0 0 260 310" focusable="false">
        <defs>
          <linearGradient id={top} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--cube-top-a)' }} />
            <stop offset=".55" style={{ stopColor: 'var(--cube-top-b)' }} />
            <stop offset="1" style={{ stopColor: 'var(--cube-top-c)' }} />
          </linearGradient>
          <linearGradient id={left} x1="0" y1="0" x2=".7" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--cube-left-a)' }} />
            <stop offset=".6" style={{ stopColor: 'var(--cube-left-b)' }} />
            <stop offset="1" style={{ stopColor: 'var(--cube-left-c)' }} />
          </linearGradient>
          <linearGradient id={right} x1="1" y1="0" x2=".2" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--cube-right-a)' }} />
            <stop offset=".55" style={{ stopColor: 'var(--cube-right-b)' }} />
            <stop offset="1" style={{ stopColor: 'var(--cube-right-c)' }} />
          </linearGradient>
          <linearGradient id={sheen} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity=".5" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* 顶面 */}
        <polygon className="cube-svg-top" points="130,30 238,96 130,162 22,96" fill={`url(#${top})`} />
        <polygon points="130,48 218,100 130,152 42,100" fill={`url(#${sheen})`} opacity=".55" />

        {/* 左面 */}
        <polygon className="cube-svg-left" points="22,96 130,162 130,290 22,224" fill={`url(#${left})`} />
        {/* 右面 */}
        <polygon className="cube-svg-right" points="238,96 130,162 130,290 238,224" fill={`url(#${right})`} />

        {/* 高光与折线 */}
        <path d="M130 30 238 96 238 224 130 290" fill="none" stroke="var(--cube-line)" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M130 30 22 96 22 224 130 290" fill="none" stroke="var(--cube-line)" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M22 96 130 162 238 96" fill="none" stroke="var(--cube-line)" strokeWidth="1" opacity=".9" />
        <path d="M38 104 130 158 222 104" fill="none" stroke="#fff" strokeWidth="2.5" opacity=".35" strokeLinecap="round" />
        <path d="M38 214 38 110" fill="none" stroke="#fff" strokeWidth="2" opacity=".2" strokeLinecap="round" />
        <path d="M222 214 222 110" fill="none" stroke="#fff" strokeWidth="2" opacity=".18" strokeLinecap="round" />

        {/* 玻璃折射条纹 */}
        <g opacity=".22" stroke="#fff" strokeWidth="1">
          <path d="M56 130 116 166" />
          <path d="M50 152 106 186" />
          <path d="M204 130 144 166" />
          <path d="M210 152 154 186" />
        </g>

        {/* 悬浮的 M 徽标 */}
        <g className="cube-badge">
          <rect x="94" y="168" width="72" height="72" rx="22" fill="rgba(255,255,255,.2)" stroke="rgba(255,255,255,.65)" strokeWidth="1.2" />
          <path
            d="M112 222V188l6 0 6 12 6-12 6 0v34h-6v-22l-6 11h-0l-6-11v22z"
            fill="var(--cube-mark)"
          />
        </g>
      </svg>
      <span className="cube-spark cube-spark-a" />
      <span className="cube-spark cube-spark-b" />
      <span className="cube-spark cube-spark-c" />
    </div>
  );
}

export default GlassCube;