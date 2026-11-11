# AGENTS.md · AI 开发手册（MCL）

> 本文件是本仓库的 **AI 代理工作手册**（agents.md 规范）：任何 AI（Claude Code / Cursor / Codex / OpenCode 等）修改本仓库时，先读这里再动手。
> 本项目由 AI 一次会话交付（见 git 历史中唯一的 feat 提交），手册内容全部来自真实踩坑，不是模板。

## 1. 项目一句话

**MCL · 新一代我的世界启动器**——为解决第三方启动器痛点而生（依据《我的世界启动器痛点大全 v4》117 条痛点 +《第三方启动器痛点词频报告》741 条 GitHub Issue 语料）。定位：P0 崩溃人话分析 / 下载稳定性 / 模组生态全解决，P1 Java 自动管理 / 实例隔离 / 存档备份，P2 登录体验 / 信任。详见 `README.md`。

## 2. 环境与验证（先做这步）

- 平台：**Windows**（开发环境）。shell 为 PowerShell 5.1（`powershell` / `pwsh` 均可）。
- 依赖：**Node.js 18+**（本机已装 26.13.0 于 `C:\Program Files\nodejs`；新终端可能缺 PATH，必要时 `$env:PATH = "C:\Program Files\nodejs;" + $env:PATH`）。
- **验证只跑两条**：

  ```powershell
  npm run typecheck   # tsc 双项目，0 错误才算过
  npm run build       # tsc + vite build，产物 dist/ + electron-dist/
  ```

- **禁止事项**：用户明确说"不用测试"。不跑 Minecraft 游戏、不实际下载游戏本体/模组/微软令牌、不发布 release。静态验证以 typecheck + build 为准。
- 不引入新 npm 依赖（主进程服务层目前**零第三方依赖**，是信任卖点的一部分）。必须引时先问用户。

## 3. 已知环境坑（务必先读）

1. **npm 拦截 postinstall**（npm v11 `allowScripts` 特性）：`npm install` 后 Electron 二进制**不会自动下载**。现在 `npm run dev` 会通过 `predev` 自动执行 `scripts/ensure-electron.js` 自愈（缺二进制时从 npmmirror 下载并解压，写 `path.txt`）；手动处理见下：
   ```powershell
   cd node_modules\electron
   $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"   # 官方源超时时用镜像
   node install.js
   ```
   若仍失败：从 `%LOCALAPPDATA%\electron\Cache\<hash>\electron-vX.Y.Z-win32-x64.zip` 手动解压到 `node_modules/electron/dist/`，并写 `path.txt` 内容为 `electron.exe`。
2. **github.com:443 可能被墙**（本机即如此），`api.github.com` 可达：`git push` 直接不通。改用 **Git Data API 入库**（blobs→trees→commits→refs），UTF-8 字节体、中文按字节提交；`git credential fill` 可取 GCM 缓存的 PAT（`protocol=https host=github.com`）。推送完用「本地重建同 sha commit → `git update-ref`」对齐本地与远程。
3. **PowerShell 编码**：`.ps1` 文件用 UTF-8 **BOM** 保存（`[System.IO.File]::WriteAllText(..., [System.Text.UTF8Encoding]::new($true))`），否则中文路径/字符串被 GBK 误读。`Invoke-RestMethod` 发送中文 JSON 时必须传 `[byte[]]` + `charset=utf-8`。
4. **控制台中文乱码**：终端输出的 mojibake 不代表 GitHub 存储的内容，用十六进制确认（`UTF8.GetBytes` 对照 `E4 B8 AD` 之类）。
5. **Electron 直接跑 `--version` 无输出属正常**（GUI 子系统），看退出码即可。

## 4. 仓库结构（三层 + 服务化）

```
electron/                 主进程（TS → CJS，rootDir electron）
  main.ts                 入口：单实例锁、无边框窗口(frame:false)、残余进程清理
  preload.ts              唯一桥：contextBridge 仅暴露 invoke/on（sandbox）
  shared/types.ts         ★ 两端唯一类型契约（Instance/Account/CrashFix…）
  services/
    paths.ts              数据目录布局（.mcl-data / shared / instances / backups / logs）
    store.ts net.ts zip.ts  基建：原子 JSON / 超时+重试+镜像映射 / 零依赖 ZIP
    downloader.ts         多线程分段下载（.part 断点续传 + SHA-1 换源）
    version.ts            Mojang 清单 + inheritsFrom 合并 + 库/资源规划
    java.ts               Java 检测/推荐/Adoptium 自动下载
    auth.ts               微软设备码 → XBL → XSTS → MC → profile；离线账号；XErr 人话翻译
    minecraft.ts          启动管线（natives 唯一目录/classpath/Aikar 参数/残余进程）
    crash.ts backup.ts modrinth.ts modpack.ts modhealth.ts migrate.ts diagnostic.ts logs.ts
    settings.ts           设置读写（deepMerge 默认值）
    ipc.ts                全部 IPC 通道注册（唯一对外接口）
src/                      渲染进程（React 18 + Vite）
  App.tsx                 侧边栏路由 + 无边框窗口按钮（win:minimize 等）
  lib/api.ts              类型安全包装（与 preload 通道一一对应）
  global.css              设计系统（纯手写 CSS 变量，无 UI 库）
  pages/                  9 页：Home Instances Mods Backups Crash Migrate Accounts Logs Settings
```

**数据目录布局**（`.mcl-data/` 开发态 / `%APPDATA%/mcl` 打包态）：
`shared/libraries|assets|versions` 全实例共享零拷贝；`instances/<id>/game/` 每实例完全隔离（saves/mods/config）；`java/` 自管 JRE；`cache/` 下载 .part；`backups/` 存档；`logs/` 日志。

## 5. 架构约束（不许破坏）

1. **渲染进程不碰 Node API**。只通过 `window.mcl.invoke(channel)` / `window.mcl.on(channel, cb)` 通信；新增功能先在 `electron/ipc.ts` 注册通道，再在 `src/lib/api.ts` 加类型化包装。
2. **主进程服务层零第三方 npm 依赖**。JSON 存储用 `store.ts`、HTTP 用 `net.ts`、压缩包用 `zip.ts`。要引依赖先问用户。
3. **两端类型唯一来源** `electron/shared/types.ts`，渲染端以 `import type ... from '../../electron/shared/types'` 引入。
4. **错误信息写人话**（面向玩家），技术细节放 `detail` 或日志；IPC 抛错，由渲染端 catch 后 toast。
5. **安全默认**：`contextIsolation + sandbox + nodeIntegration:false`、外部链接仅 `^https?://`、诊断包导出必须脱敏（apiKey 等）。
6. **实例隔离不可破坏**：每个实例 = 独立 `game/` 目录；库/资源只通过 `paths.ts` 的 shared 目录引用。
7. **下载总是走镜像映射 + 失败换源**，绝不允许静默失败或"关闭校验"式绕过。

## 6. 代码规范

- TypeScript **strict**，`typecheck` 必须 0 错误。
- 中文 UI + 中文面向用户文案；代码注释中文。
- 函数单一职责；文件名 kebab-case（`.ts`）/ PascalCase（`.tsx` 页面组件）。
- 无用的导入/变量顺手删掉（tsconfig 没开 noUnusedLocals，靠自觉）。
- 不写死路径/密钥/令牌。`settings.curseforge.apiKey`、`accounts.json` 都只存本机。

## 7. 常见任务 → 去哪改

| 要做什么 | 改哪里 |
|---|---|
| 加新页面/改布局 | `src/App.tsx`（路由+侧边栏）、`src/pages/<Name>.tsx`、`src/global.css` |
| 加 IPC 通道 | `electron/shared/types.ts` → `electron/services/ipc.ts` → `src/lib/api.ts` 一一对应 |
| 崩溃新规则 | `electron/services/crash.ts` 的 `RULES` 数组（正则 + 人话 summary + 一键修复动作） |
| 下载源/镜像 | `electron/services/net.ts` 的 `mapToMirror` |
| 启动参数/内存预设 | `electron/services/minecraft.ts` 的 `MEMORY_PRESETS` 与 args 组装 |
| 模组来源/更新 | `electron/services/modrinth.ts`；体检逻辑 `modhealth.ts` |
| 设置项（必须带 Tip 解释）| `electron/services/settings.ts` 默认值 + `Settings.tsx` 行（每项配 `<Tip>`）|
| 数据目录布局 | `electron/services/paths.ts`（改这里要同步 README 目录结构图）|

## 8. 交付流程（用户原话：开发完需要测试 → 直接 git 到 GitHub）

```powershell
git add -A && git commit -m "feat: ..."   # 或 fix: / docs: / refactor:
# github.com 可达：git push -u origin master
# 不可达：Git Data API 推送（见 §3.2；全程无法 fetch）
```

- 仓库：`MistHowlJade/mcl`，默认分支 `master`，公开。commit 用 `MistHowlJade <MistHowlJade@users.noreply.github.com>`。
- 不提交 `node_modules/ dist/ electron-dist/ .mcl-data/ *.log`（已在 .gitignore）。
- CI = typecheck + build，不跑游戏。别把游戏本体/模组/账号文件加进仓库。

## 9. 已知限制与待办（动手前知道自己在什么上面）

- ❌ **未真正实测运行**：游戏下载/启动/崩溃链路从未执行过。Forge/NeoForge 静默安装器（`ensureForgeLikeInstalled`）风险最高。
- 离线皮肤：官方限制，仅自己可见；微软账号走官方皮肤。
- Forge 系启动未统一进共享库布局（安装到实例 `game/libraries` 后按 `versions/` 读取）。
- 无云同步（路线图）、无代码签名、Windows 优先。
- `npm run dev` 依赖手动修好的 electron 二进制（见 §3.1）。
