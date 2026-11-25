import React from 'react';

/**
 * 像素方块世界：首页主视觉。
 * 纯 SVG 矩形拼成（无外部图片、无第三方依赖），颜色走 CSS 变量，明暗主题共用一套构图。
 * 构图元素集中在画面中部，宽高比变化（窗口缩放）时不会被裁掉。
 */
export function PixelScene({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`pixel-scene ${className}`}
      viewBox="0 0 320 200"
      preserveAspectRatio="xMidYMid slice"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {/* 天空 */}
      <rect className="px-sky" x="0" y="0" width="320" height="200" />
      <rect className="px-sky-low" x="0" y="96" width="320" height="52" />

      {/* 太阳与光晕 */}
      <rect className="px-sun-halo" x="196" y="16" width="60" height="60" />
      <rect className="px-sun-halo" x="204" y="24" width="44" height="44" />
      <rect className="px-sun" x="212" y="32" width="28" height="28" />

      {/* 云 */}
      <g className="px-cloud">
        <rect x="28" y="44" width="80" height="8" />
        <rect x="36" y="36" width="52" height="8" />
        <rect x="44" y="28" width="28" height="8" />
        <rect x="150" y="60" width="56" height="8" />
        <rect x="158" y="52" width="32" height="8" />
        <rect x="96" y="76" width="40" height="6" />
      </g>

      {/* 远山 */}
      <g className="px-hill-far">
        <rect x="0" y="124" width="320" height="16" />
        <rect x="36" y="116" width="32" height="8" />
        <rect x="44" y="108" width="16" height="8" />
        <rect x="164" y="116" width="40" height="8" />
        <rect x="176" y="108" width="16" height="8" />
        <rect x="252" y="120" width="36" height="4" />
      </g>
      <g className="px-hill-near">
        <rect x="0" y="132" width="320" height="8" />
        <rect x="84" y="128" width="36" height="4" />
        <rect x="212" y="128" width="52" height="4" />
      </g>

      {/* 地面剖面：草 / 土 / 石 */}
      <rect className="px-grass" x="0" y="140" width="320" height="12" />
      <g className="px-grass-dark">
        <rect x="8" y="140" width="12" height="4" />
        <rect x="44" y="144" width="8" height="4" />
        <rect x="74" y="140" width="16" height="4" />
        <rect x="118" y="144" width="10" height="4" />
        <rect x="150" y="140" width="8" height="4" />
        <rect x="188" y="144" width="14" height="4" />
        <rect x="272" y="140" width="12" height="4" />
        <rect x="300" y="144" width="8" height="4" />
      </g>
      <rect className="px-dirt" x="0" y="152" width="320" height="32" />
      <g className="px-dirt-dark">
        <rect x="16" y="160" width="12" height="8" />
        <rect x="52" y="172" width="8" height="8" />
        <rect x="92" y="156" width="16" height="8" />
        <rect x="132" y="168" width="10" height="8" />
        <rect x="168" y="158" width="8" height="8" />
        <rect x="206" y="172" width="14" height="8" />
        <rect x="248" y="162" width="10" height="8" />
        <rect x="288" y="170" width="14" height="8" />
      </g>
      <rect className="px-stone" x="0" y="184" width="320" height="16" />
      <g className="px-stone-dark">
        <rect x="24" y="188" width="16" height="8" />
        <rect x="88" y="192" width="10" height="8" />
        <rect x="146" y="188" width="14" height="8" />
        <rect x="218" y="190" width="12" height="8" />
        <rect x="276" y="188" width="18" height="8" />
      </g>

      {/* 树 */}
      <g>
        <rect className="px-trunk" x="108" y="116" width="8" height="24" />
        <rect className="px-trunk-dark" x="112" y="116" width="4" height="24" />
        <g className="px-leaf">
          <rect x="88" y="108" width="48" height="12" />
          <rect x="94" y="98" width="36" height="12" />
          <rect x="102" y="90" width="20" height="10" />
          <rect x="82" y="116" width="60" height="6" />
        </g>
        <g className="px-leaf-dark">
          <rect x="94" y="110" width="8" height="6" />
          <rect x="112" y="100" width="10" height="6" />
          <rect x="124" y="110" width="8" height="6" />
          <rect x="102" y="92" width="6" height="6" />
        </g>
      </g>

      {/* 小屋 */}
      <g>
        <rect className="px-chimney" x="216" y="82" width="10" height="24" />
        <rect className="px-smoke" x="220" y="70" width="6" height="6" />
        <rect className="px-smoke" x="226" y="58" width="6" height="6" />
        <rect className="px-wall" x="180" y="112" width="48" height="28" />
        <rect className="px-wall-dark" x="180" y="132" width="48" height="8" />
        <rect className="px-roof" x="172" y="104" width="64" height="8" />
        <rect className="px-roof-dark" x="180" y="96" width="48" height="8" />
        <rect className="px-roof" x="188" y="88" width="32" height="8" />
        <rect className="px-door" x="196" y="124" width="10" height="16" />
        <rect className="px-window" x="214" y="118" width="10" height="10" />
      </g>

      {/* 地面点缀 */}
      <g className="px-speck">
        <rect x="12" y="146" width="4" height="4" />
        <rect x="104" y="148" width="4" height="2" />
        <rect x="176" y="146" width="4" height="4" />
        <rect x="298" y="148" width="4" height="2" />
      </g>
    </svg>
  );
}

export default PixelScene;