# MCL 代码审查报告

- 审查对象：`MistHowlJade/mcl`，HEAD `a2ef052`（`feat: PCL2 风格全套… (#65)`）
- 规模：99 个文件，约 14,690 行（主进程服务 ~9k，渲染进程 ~5k）
- 审查方式：全量静态阅读 + `typecheck` / `build` / `smoke-check`
- 说明：未修改任何功能代码；本报告为新增文档。

## 一、总体结论

项目架构清晰、分层约束执行得很好：主进程服务零第三方依赖、类型契约单一来源、渲染进程只经 preload IPC 通信。安全基线（`contextIsolation + sandbox + nodeIntegration:false`）、路径校验、云同步脱敏、下载 SHA-1 校验与 ZIP 目录穿越防护都做得比较扎实，静态检查零错误。

主要风险集中在四类：

1. 离线启动链路存在不一致的联网依赖；
2. 备份恢复 / ZIP 边界仍有可绕过的白名单缺口；
3. 进程与文件并发的鲁棒性（PID 复用、流重定向、丢更新）；
4. 若干“注释承诺与实际实现不符”的校验缺口。

没有发现阻断编译或必然导致数据丢失的问题，但下列条目建议按优先级处理。

## 二、验证结果

| 项目 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | 双 TS 项目，0 错误 |
| `npm run build` | 通过 | `tsc` + Vite，产物正常 |
| `node scripts/smoke-check.js` | 环境受限 | 直接运行因 Electron 二进制未下载完成而失败（`Electron failed to install correctly`），非代码错误 |
| smoke-check（注入 `electron` 桩后） | **39/39 通过** | 覆盖规则引擎、镜像映射、版本解析、崩溃归因、ZIP/ZIP64 等 |

> 审查环境为 Linux，未做 Windows 真机 / 游戏启动 / 服务端安装 / WebDAV / Gist 实测，与 `AGENTS.md` 中“未真正实测运行”的现状一致。

## 三、优点（值得保持）

- `electron/services/ipc.ts`：几乎所有接受路径的通道都做 `id` 正则、`path.basename`、`startsWith(root + sep)` 校验；外部链接仅 `^https?://`；运行中的游戏会阻止备份/删除/导出等危险操作。
- `electron/main.ts`：`mcl-media` 协议限制在数据目录内且仅图片 MIME；`will-navigate` 阻止远程页面加载 preload IPC。
- `electron/services/cloud.ts`：上传前剔除 `accounts.json`、API Key、云凭据、代理凭据；恢复时也不会用远端凭据覆盖本机。
- `electron/services/downloader.ts`：SHA-1 校验、失败换源、`.part` 断点续传、分段下载校验与进度回滚完整。
- `electron/services/zip.ts`：目录穿越防护、条目数/总大小上限、流式解压输出上限、ZIP64 支持。

## 四、问题清单

### 高

#### 1. 备份恢复可绕过白名单，把任意文件写进游戏目录
- 位置：`electron/services/backup.ts:194-200`、`:286-288`
- 问题：`alreadyPrefixed` 只有在条目中出现 `saves` / `saves/...` 时才为 true。若一个 ZIP **没有** `saves/` 前缀且根目录也没有 `level.dat`，则既不会进入白名单校验（196-200），也不会进入世界恢复分支（203），最终落到 `:287` 的 `zipExtractAllFromFile(zipPath, gameDir)`，把包内所有文件原样写进游戏根目录。注释声称“只允许还原到白名单子目录”，实际未执行。
- 影响：精心构造的备份包可放入 `mods/evil.jar`，下次启动被当作模组加载，等同代码执行。正常 MCL 自产备份不受影响，但共享/手工放入的备份包存在风险。
- 建议：无论是否有 `saves/` 前缀，都对**每一个**条目做顶层白名单校验（`BACKUP_SUBSET`），并对 `mods/`、`config/` 等一律拒绝；或要求恢复包必须带受信任的元数据 `kind` 后才允许非白名单路径。

### 中

#### 2. 离线启动链路不一致：资源索引与加载器 profile 每次都联网
- 位置：`electron/services/version.ts:403-453`、`electron/services/minecraft.ts:275-297`、`:306-309`、`:554`
- 问题：版本清单有旧缓存兜底（`version.ts:80-84`），版本 JSON 有本地缓存（`version.ts:229-240`）；但 `fetchAssetIndex` 的对象分支（`:421-453`）无条件请求网络，即使 `<assets>/indexes/<id>.json` 已存在；Fabric/Quilt 的 loader profile 与“最新 loader 版本”也每次都 `fetchJson`，无缓存。
- 影响：断网或 Modrinth/Fabric 元数据服务不可用时，即使游戏文件已完整下载也会启动失败，与项目“下载稳定性”的定位冲突。
- 建议：对象分支先读本地索引并校验 `ai.sha1`；loader profile 按 `loader + mcVersion + loaderVersion` 落盘到 `cache/`，失败时回退缓存；`latest*Loader` 结果同样短时缓存。

#### 3. 用户指定的 Java 路径不校验主版本
- 位置：`electron/services/java.ts:168-181`、`electron/services/minecraft.ts:513-514`
- 问题：`pickJavaFor` 计算出了 `recommendedMajor`（来自版本 JSON 的 `javaVersion.majorVersion`），但 override 分支在 `fs.existsSync(overridePath)` 且能读出版本后直接返回，不比较 `info.major` 与 `recommendedMajor`。
- 影响：用户在“高级设置”里手填 Java 8 来启动 1.20.5+/1.21+（需 Java 21）时会直接启动失败；自动管理路径反而没问题。
- 建议：override 的 major 小于要求时给出明确错误或至少警告；major 不匹配要求时也提示（新版本通常可兼容，但需提示风险）。

#### 4. 启动前库完整性检查只识别 0 字节文件
- 位置：`electron/services/minecraft.ts:141-155`、`:604`
- 问题：`findCorruptedLibraries` 对已有文件只检查 `stat.size === 0`，注释却写“sha1 抽检”。真正做全量哈希的是一键修复 `repairLibraries`（`:254-260`），启动流程不会调用。
- 影响：非 0 字节的截断/损坏 jar 会进入 classpath，表现为难以定位的启动崩溃。
- 建议：复用 `downloader.ts` 的 `verified-files.json` 缓存做增量 SHA-1 校验；或对小于阈值（如 16 MB）的库同步哈希，大的走后台校验。

#### 5. 残余进程清理可能因 PID 复用误杀其它 Java 程序
- 位置：`electron/services/minecraft.ts:74-114`、`electron/main.ts:143-147`、`electron/services/minecraft.ts:493-497`
- 问题：`residual-pids.json` 只存 PID；清理时仅通过 `tasklist` / `ps` 确认进程名是 `java`，没有校验命令行、启动时间或工作目录。系统重启后 PID 被复用、恰好是另一个 Java 程序时会被 `taskkill /T /F` 或 `SIGKILL` 结束。该逻辑在启动器启动和每次游戏启动前自动执行。
- 建议：记录 PID + 进程启动时间（或命令行 hash + 实例 id），清理时全部匹配才杀；否则只清理记录文件，不杀进程。

#### 6. WebDAV 流式上传遇到重定向会复用已消费的流
- 位置：`electron/services/net.ts:44-68`、`:87-95`、`electron/services/cloud.ts:478-483`
- 问题：`fetchWithTimeout` 的 body 是 `fs.ReadStream`，首次请求已 `pipe(req)`；若服务器返回 301/302/307/308，递归请求复用同一个 `options.body`，流已被消费，第二次上传会变成空/截断内容。303 虽改为 GET，但仍保留 `Content-Length` 等头。
- 影响：部分 WebDAV 服务（目录末尾缺 `/`、HTTP→HTTPS 跳转）会上传损坏的空快照，且服务端返回成功。
- 建议：带 body 的请求遇到重定向时直接报错让用户修正地址，或每次重试前重新 `createReadStream`；重定向到不同 URL 时重算 `Content-Length`。

#### 7. 跨域重定向只移除 `Authorization`，其它凭据头会泄漏
- 位置：`electron/services/net.ts:59-67`
- 问题：跨域跳转时只删除 `Authorization`/`authorization`。`fetchJson` 的自定义头会被原样带到新 host，例如 CurseForge 的 `x-api-key`（`electron/services/modpack.ts:202`）、`Cookie` 等。
- 建议：跨域重定向时清空所有自定义头，或按白名单只保留 `User-Agent`/`Accept`。

### 低

#### 8. HTTP 响应体读取没有绝对超时
- 位置：`electron/services/net.ts:81-84`、`electron/services/proxy.ts:121,140,160,187`
- 问题：`req.setTimeout` 是**空闲**超时，服务端持续以极慢速度发送字节可让 `fetchWithTimeout` 永远不结束；`chunks` 也无大小上限。
- 建议：加绝对 deadline（定时器 `req.destroy`）与响应体大小上限。

#### 9. ZIP 解压上限仍可能耗尽磁盘；不校验 CRC
- 位置：`electron/services/zip.ts:16-17`、`:479`、`:651-657`、`:621-682`
- 问题：总解压上限 64 GB，对“整合包导入 / 云端快照”这类外部输入仍然过大；流式解压按声明大小限制输出，但不校验 CRC，且 stored（method 0）条目不核对 `written === uncompressedSize`。
- 建议：对不可信来源单独设更低的容量上限（如 2–8 GB）并检查剩余磁盘空间；解压完成后校验 CRC。

#### 10. 恶意小 ZIP 可能触发 `RangeError`
- 位置：`electron/services/zip.ts:411-415`
- 问题：`readZip64Directory` 在 `eocd < 56` 时从负索引开始 `buf.readUInt32LE(i)`，畸形小包会抛出未包装的 RangeError，而不是可读错误。
- 建议：循环从 `Math.max(0, eocd - 56)` 开始，并先校验 `eocd >= 56`。

#### 11. 配置/实例更新是读-改-写，无串行化
- 位置：`electron/services/store.ts:23-27`（`updateJson` 当前未被使用）、`electron/services/settings.ts:170-176`、`electron/services/instances.ts:127-174`
- 问题：多个 IPC 并发更新同一文件时可能互相覆盖（例如设置页连续 patch 与云同步回写 `lastSyncAt`）。前端用 `patchSeq` 只解决展示顺序，不解决主进程落盘竞态。
- 建议：对 `config.json` / `instance.json` 的写操作加进程内队列或串行 Promise 链。

#### 12. natives 目录在异常退出时累积
- 位置：`electron/services/minecraft.ts:621`、`:770-810`
- 问题：`natives-<timestamp>` 只在 `close` / `error` 时清理；被任务管理器结束、系统断电、崩溃到无法触发事件时会残留。
- 建议：启动时扫描 `<instance>/natives/`，清理超过 N 天或不属于当前 PID 的目录。

#### 13. 代理密码 / 访问令牌出现在 JVM 命令行
- 位置：`electron/services/proxy.ts:78-83`、`electron/services/minecraft.ts:658,668`
- 问题：`-Dhttp.proxyPassword=...` 与 `auth_access_token` 会显示在系统进程列表/任务管理器中。令牌通过命令行传给 Minecraft 是启动器常见做法，但代理密码本可避免。
- 建议：文档明确说明；对代理密码评估是否能只写进 JVM 参数文件或使用其它认证方式。

#### 14. 小问题
- `src/App.tsx:68-71`：每 5 秒轮询 `accounts:active`，长时间运行有少量 IPC 开销；可改为事件驱动或延长间隔。
- `scripts/smoke-check.js` 依赖 `require('electron')` 间接加载 `paths.js`，在未下载 Electron 二进制的 CI/环境中无法直接运行；可考虑在 `paths.ts` 中延迟访问 `app.isPackaged`，或让 smoke-check 注入 stub。

## 五、建议处理顺序

1. 修复备份恢复白名单绕过（#1）；
2. 补齐离线缓存与 Java 版本校验（#2、#3）；
3. 加固网络边界：重定向凭据与流式上传（#6、#7、#8）；
4. 进程与完整性校验（#4、#5）；
5. 其余低优先级项按版本迭代处理。
