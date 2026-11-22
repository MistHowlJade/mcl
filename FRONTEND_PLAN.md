# 前端改版方案（PCL2 风格统一）

> 状态：**已按确认方案实施第一阶段与小范围功能补齐**（见文末“实施状态”）。
> 约束：不新增 npm 依赖、不改 `electron/shared/types.ts`、不改 IPC 通道与业务服务；只动 `src/` 下的 UI 层。

## 0. 现状问题诊断

1. **视觉**：所谓“PCL2 浅色”只是在 Aurora Glass 设计系统上叠了约 60 行变量覆盖（`global.css:787-848`）。底层仍是玻璃模糊、噪点、网格、发光阴影、20px 大圆角、渐变背景，导致“浅色但不 PCL”。
2. **交互**：加载态多为纯文字“正在加载…”，空状态不统一；长任务只有 toast，没有就近进度；部分按钮在任务进行中只是报错后才反馈。
3. **信息架构**：12 个页面平铺在 4 个分组里，低频项（迁移/日志/云同步）与高频项混排；标题栏放主题切换，不像 PCL2。
4. **代码质量**：`global.css` 866 行单文件；`Home/Instances/Mods/Content/Backups/Crash/Logs` 各自重复写 `reloadSeq`、`instanceIdRef`、localStorage 选中实例、加载/空状态；`PageHeader/Panel/Field/StatusTag` 等基础组件没有抽象。
5. **功能缺失**：没有全局状态反馈入口；服务端控制台没有命令历史；模组更新只能逐个操作；备份恢复前缺少直观说明；“外观/导航样式”藏在设置页深处。

## 1. 视觉系统：把 PCL2 变成真正的主设计系统

文件调整：

- `src/styles/tokens.css`：PCL2 为默认 `:root`；Aurora 改为 `[data-theme="aurora"]` 的暗色备选（默认不再加载其玻璃/噪点效果）。
- `src/styles/base.css`：reset、字体、滚动条、focus 环。
- `src/styles/components.css`：按钮、输入框、卡片、标签、开关、弹窗、Toast、Tab。
- `src/styles/pages.css`：页面级布局（首页、实例卡片、服务器详情等）。
- `src/main.tsx`：按 tokens → base → components → pages 顺序 import，删除对旧 `global.css` 的整块依赖；旧文件保留为兼容层直到全部迁移完成。

PCL2 视觉规范：

| 项 | 目标 |
|---|---|
| 背景 | 纯浅蓝白 `#F4F8FD`，卡片纯白 |
| 主色 | `#2F8FE8`，hover `#1D72D2`，危险 `#E65858` |
| 圆角 | 8–12px，不用 20px |
| 边框 | `1px solid #D6E4F5` |
| 阴影 | `0 2px 8px rgba(31,83,145,.06)`，不用发光/大扩散阴影 |
| 标题栏/侧栏 | 白色实底，不用 `backdrop-filter` |
| 纹饰 | 去掉网格/噪点/渐变光斑 |
| 启动按钮 | 蓝色主按钮，尺寸更醒目，但不用霓虹渐变 |

## 2. 布局与信息架构

改动文件：`src/App.tsx`、`src/lib/theme.ts`、`src/styles/*`

- 默认 `theme = 'pcl'`、`nav = 'side'`；保留顶部标签模式但按 PCL2 Tab 样式重做。
- 标题栏移除主题切换按钮，只留品牌、版本号和窗口按钮；主题/导航样式移入「设置 → 外观」。
- 导航重新分组：

  ```
  游戏        启动台 / 实例 / 服务器
  模组与资源   模组中心 / 内容管理 / 存档备份
  诊断与工具   崩溃分析 / 迁移中心 / 日志
  账号与同步   账号 / 云同步
  系统        设置
  ```

- 分组可折叠，状态写入 localStorage；侧栏底部保留账号卡片。
- 新增**全局状态条**（位于标题栏下或内容区顶部）：显示启动/下载/服务端状态、进度和“查看”入口，点击跳到对应页面。

## 3. 通用组件与 Hooks（解决代码质量）

新增 `src/components/ui.tsx`（或拆分小文件）：

- `PageHeader`、`Panel`、`EmptyState`、`Field`、`Segmented`、`StatusTag`、`BusyButton`、`StatCard`。
- 从页面中抽出 `InstanceTile`、`ServerCard`、`ModRow`、`BackupRow`。

新增 `src/lib/hooks.ts`：

- `useAsyncList<T>(loader, deps)`：统一 `seq` 竞态保护 + 错误 toast + loading。
- `useInstanceSelection()`：统一 `mcl:selectedInstance` 的读写和失效回退。
- `useAsyncAction()`：统一 busy 状态、成功/失败 toast。

> 目标：把 5 个页面里重复的 `reloadSeq.current++` / `instanceIdRef.current` / `localStorage` 逻辑收敛到 hooks，页面只保留业务差异。

## 4. 页面改版清单

| 页面 | 改版要点 |
|---|---|
| 启动台 | PCL2 大启动按钮 + 当前实例信息卡；快捷操作改紧凑网格；崩溃诊断改为内联 alert；日志区可折叠 |
| 实例 | 卡片式封面 + loader/版本/内存/Java 徽标；操作收进卡片底部；高级设置用统一 Field 表单 |
| 服务器 | 左侧服务器列表 + 右侧详情；控制台改成终端卡片；属性页用 Field 表单；备份列表独立 Tab |
| 模组中心 | PCL2 式页面 Tab；已安装列表支持多选“批量更新”；体检报告改成结构化 alert 列表 |
| 内容管理 | 资源包/光影/截图/世界统一网格卡片；拖放高亮；导入按钮进工具栏 |
| 存档备份 | 恢复前明确列出将被覆盖的世界；增加“打开备份目录”；空状态给一键备份 CTA |
| 崩溃分析 | 诊断结果卡片 + 修复动作列表；粘贴分析保留 |
| 迁移中心 | 候选启动器卡片 + 预览表格 + 进度条；强调“复制模式不改动原数据” |
| 账号 | 账号列表卡片化；皮肤预览保持像素风格；安全说明收进折叠面板 |
| 云同步 | 配置表单分区；状态卡片；上传/下载确认保持 |
| 日志 | 文件列表 + 日志查看器改为双栏；搜索/读取长度控制保留 |
| 设置 | 所有设置项用 Field 行；新增“外观”分区放主题和导航样式；每项 Tip 保留 |

## 5. 交互与功能补齐（小范围）

1. 全局状态条：启动/下载/服务端状态就近可见、可跳转。
2. 服务端控制台：↑/↓ 命令历史。
3. 模组中心：批量检查更新 + 批量更新（带确认）。
4. 备份页：恢复前预览 + 打开备份目录。
5. 所有长任务：就近进度条/骨架屏，不只靠 toast。
6. 空状态统一：标题、说明、主 CTA。

## 6. 实施阶段

1. **阶段一：设计系统** — 拆分 CSS、建立 PCL2 tokens、重做 App 壳和导航。验收：`typecheck`/`build` 通过，页面无破损。
2. **阶段二：基础组件 + Hooks** — 建立 ui/hooks，重构启动台、实例、设置三页作为样板。
3. **阶段三：页面铺开** — 其余 9 页按组件体系改版。
4. **阶段四：交互与功能补齐** — 状态条、命令历史、批量更新、空状态、骨架屏。
5. **阶段五：清理与验收** — 删除旧 CSS 兼容层，跑 `npm run typecheck`、`npm run build`、`smoke-check`。

## 7. 风险与待确认

- 不改业务/类型/IPC，理论上不影响启动器核心能力。
- 环境里 Electron 二进制未下载完成，无法做真机截图；改完需要你在 Windows 上 `npm run dev` 目视验收。
## 8. 实施状态（已确认并执行）

用户确认：彻底删除 Aurora 暗色、采用新导航分组、全部补齐小功能。已完成：

- [x] 删除 `Theme`/`getTheme`/`setTheme` 与标题栏主题按钮；`src/lib/theme.ts` 只保留导航偏好。
- [x] 重写 `src/global.css` 为单一 PCL2 浅色设计系统（去掉玻璃模糊、噪点、渐变光斑、发光阴影；CSS 从 42 KB 降到 30 KB）。
- [x] 侧栏导航改为 5 组：游戏 / 模组与资源 / 诊断与工具 / 账号与同步 / 系统。
- [x] 新增全局状态条（启动 / 下载 / 服务端 / 更新），点击可跳转对应页面。
- [x] 新增 `src/lib/hooks.ts`（`useInstanceSelection` / `useAsyncList` / `useAsyncAction`），并重构备份页、日志页去掉重复的竞态与选中实例逻辑。
- [x] 新增 `src/components/ui.tsx`（`EmptyState` / `Skeleton` / `PageSkeleton`），首页加载改为骨架屏，备份空状态统一。
- [x] 服务端控制台 ↑/↓ 命令历史。
- [x] 模组中心“更新全部”批量更新。
- [x] 备份恢复确认框列出将被替换的世界；新增“打开备份目录 / 定位”入口。
- [x] 修正页面内联的深色代码块背景，统一为浅色主题。
- [x] 新增「资源下载」页：整合包 / 资源包 / 光影包 / 地图世界四类 Modrinth 搜索与下载；整合包下载后自动导入为新实例。
- [x] `npm run typecheck`、`npm run build`、39 项 smoke-check 全部通过。

未做（如需可继续）：其余 9 个页面的组件化重构仍保留原有内联结构，仅通过全局 CSS 完成视觉统一；未在 Windows 真机目视验收（环境无 Electron 二进制）。
