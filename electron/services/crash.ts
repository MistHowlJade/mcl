/**
 * 崩溃分析器 —— MCL 的核心差异化能力（痛点 #26/#27/#25/#29/#82）
 * 把几千行堆栈翻译成人话 + 一键修复动作
 */
import * as fs from 'fs';
import * as path from 'path';
import * as paths from './paths';
import { CrashDiagnosis, CrashFix } from '../shared/types';

interface CrashRule {
  id: string;
  pattern: RegExp;
  title: string;
  summary: string | ((m: RegExpMatchArray) => string);
  detail: string | ((m: RegExpMatchArray) => string);
  severity: 'low' | 'medium' | 'high';
  fixes: CrashFix[];
}

const MAJOR_TO_JAVA: Record<number, number> = { 45: 1, 46: 2, 47: 3, 48: 4, 49: 5, 50: 6, 51: 7, 52: 8, 53: 9, 54: 10, 55: 11, 56: 12, 57: 13, 58: 14, 59: 15, 60: 16, 61: 17, 62: 18, 63: 19, 64: 20, 65: 21, 66: 22, 67: 23, 68: 24, 69: 25 };

const RULES: CrashRule[] = [
  {
    id: 'unsupported-class-version',
    // 去掉跨行贪婪的 (\d+)\.0.*?class file 与 s 标志：正常日志里的 "1.20.0" + "class file cache" 会误报
    // 去掉裸「major version」分支（协议日志会误报），补上旧 JVM 的 Unsupported major.minor version 句式
    pattern: /UnsupportedClassVersionError[^\n]*?(?:major(?:\.minor)?|class file) version (\d+(?:\.\d+)?)|class file version (\d+(?:\.\d+)?)|Unsupported major\.minor version (\d+(?:\.\d+)?)/i,
    title: 'Java 版本不匹配',
    summary: (m) => {
      const major = parseInt(m[1] ?? m[2] ?? m[3] ?? '0', 10);
      const need = MAJOR_TO_JAVA[major] ?? major;
      return `这个版本的 Minecraft / 模组需要 Java ${need}，而启动器选用的 Java 版本太老（或整合包自带的 Java 太新）。这是闪退最常见的原因之一。`;
    },
    detail: 'UnsupportedClassVersionError 表示字节码版本高于当前 JVM 能识别的最大版本。Java 8 = 52，Java 17 = 61，Java 21 = 65。常见报文："class file version 61.0"。',
    severity: 'high',
    fixes: [
      { id: 'switch-java', label: '自动切换到正确版本的 Java', description: 'MCL 会按游戏版本自动选择（1.16.5 及以下用 Java 8；1.17–1.20.4 用 Java 17；1.20.5+ 用 Java 21），缺失会自动下载。', action: 'fix:switchJava', severity: 'high' },
    ],
  },
  {
    id: 'out-of-memory',
    pattern: /OutOfMemoryError|GC overhead limit exceeded|Java heap space/i,
    title: '内存不足',
    summary: '给游戏分配的内存用光了。大型整合包 / 开光影时，默认 2G 通常不够用。',
    detail: 'OutOfMemoryError: Java heap space 表示堆内存溢出；GC overhead limit 表示垃圾回收占用了 98% 时间仍回收不到内存。',
    severity: 'high',
    fixes: [
      { id: 'memory-heavy', label: '切换到「大型整合包 / 光影」预设', description: '分配 4G 初始 / 8G 最大内存，并启用 G1GC 与低停顿参数（Aikar 参数）。', action: 'fix:setMemoryPreset', args: { preset: 'heavy' }, severity: 'high' },
      { id: 'memory-standard', label: '切换到「标准」预设（4G）', description: '适合大部分整合包。', action: 'fix:setMemoryPreset', args: { preset: 'standard' }, severity: 'medium' },
    ],
  },
  {
    id: 'mixin-apply-failed',
    pattern: /Mixin apply failed|MixinApplyError|LVT in pre-apply|Critical injection failure/i,
    title: '模组（Mixin）冲突或版本不匹配',
    summary: '某个模组对游戏代码的"注入"失败了——通常是模组版本与 Minecraft / 加载器版本对不上，或者两个模组改了同一处。',
    detail: 'Mixin 是模组修改游戏字节码的机制。注入点找不到时常意味着 MC 版本、加载器版本或目标模组版本不匹配。',
    severity: 'high',
    fixes: [
      { id: 'open-mods', label: '打开 mods 文件夹，排查最近更新的模组', description: '二分法：先禁用最近更新的模组（把 .jar 重命名为 .jar.disabled），逐个排查。', action: 'fix:openModsFolder', severity: 'high' },
      { id: 'repair-libs', label: '修复游戏库文件', description: '重新校验并下载损坏的库文件（SHA-1 不匹配会自动重下）。', action: 'fix:repairLibraries', severity: 'medium' },
    ],
  },
  {
    id: 'missing-dependency',
    // Fabric 的实际句式是 "requires X of Y, which is missing!"，旧正则要求 "but" 导致漏报
    pattern: /Missing or unsupported mandatory dependencies|missing mandatory dependency|requires .*?which is missing|Incompatible mods found/i,
    title: '缺少前置模组',
    summary: '某个模组需要另一个"前置模组"才能运行，但 mods 目录里没有它（或版本不对）。',
    detail: 'Forge/NeoForge 会列出缺失的前置。常见前置：Fabric API、Architectury API、Forge Config API Port、Cloth Config 等。',
    severity: 'high',
    fixes: [
      { id: 'open-mods-dep', label: '打开 mods 文件夹对照报错补齐前置', description: '报错信息里会写清楚缺哪个模组、需要什么版本，按名字搜索并安装即可。', action: 'fix:openModsFolder', severity: 'high' },
    ],
  },
  {
    id: 'opengl',
    // 裸「显卡」会误报普通调试日志；只保留真正的图形错误特征
    pattern: /Pixel format not accelerated|OpenGLException|Failed to create (?:an? )?OpenGL|GLFW error|GLFWException|glGetError|no suitable pixel format/i,
    title: '显卡 / 驱动不支持',
    summary: '显卡无法创建游戏需要的图形环境。核显笔记本、驱动太旧、或开了不兼容的"加速渲染"时常见。',
    detail: 'OpenGL 上下文创建失败通常与驱动有关：更新显卡驱动、关闭光影、或切换到独显运行。',
    severity: 'high',
    fixes: [
      { id: 'open-mods-gl', label: '暂时移除光影并重启', description: '把 shaderpacks 里的光影包先移走试试；若恢复正常，说明是光影包本身的问题。', action: 'fix:openModsFolder', severity: 'medium' },
    ],
  },
  {
    id: 'natives-lwjgl',
    // 「natives loaded successfully without error」不能命中，失败词必须跟 load/extract/find/locate
    pattern: /UnsatisfiedLinkError[^\n]*|Failed to locate library[^\n]*|natives?[^\n]{0,80}(?:failed to (?:load|extract|find|locate)|could not (?:load|extract|find|locate)|unable to (?:load|extract|find|locate)|找不到)/i,
    title: '原生库（natives）损坏或被占用',
    summary: '游戏依赖的本地库文件（如 lwjgl.dll）加载失败——可能是文件损坏，也可能是上一次游戏没退干净、文件被占用。',
    detail: 'LWJGL 提供 OpenGL/GLFW 绑定。UnsatisfiedLinkError 常见原因：natives 未解压 / 被安全软件拦截 / 文件被占用 / 32 位 natives 混入 64 位运行环境。',
    severity: 'high',
    fixes: [
      { id: 'reextract-natives', label: '重新提取 natives', description: 'MCL 每次启动都会提取到唯一目录，天然规避"dll 被占用"。此操作清理旧残留。', action: 'fix:reextractNatives', severity: 'high' },
      { id: 'repair-libs-native', label: '修复游戏库文件', description: '重新校验并下载损坏的库文件。', action: 'fix:repairLibraries', severity: 'high' },
    ],
  },
  {
    id: 'tls-too-old',
    // 裸 TLSv1.3 是正常协议日志，只有和 SSLHandshakeException 同时出现才算 Java 8 过旧
    pattern: /SSLHandshakeException[^\n]{0,160}(?:TLSv?1\.3|TLS 1\.3)|(?:TLSv?1\.3|TLS 1\.3)[^\n]{0,160}SSLHandshakeException|NoSuchMethodError[^\n]{0,120}SSL/i,
    title: 'Java 8 版本过低，不支持 TLS 1.3',
    summary: '你的 Java 8 小版本低于 8u291，连接微软验证服务器会失败，报出来的错和网络毫无关系，非常有迷惑性。',
    detail: 'TLS 1.3 需要 Java 8u261+（完整支持 8u291+）。旧版 Java 调 SSLContext.getDefault() 会走不支持 TLS1.3 的实现。',
    severity: 'high',
    fixes: [
      { id: 'switch-java-tls', label: '切换到受支持的 Java', description: '升级 Java 8 到 8u291 以上，或让 MCL 自动选择更新的 Java。', action: 'fix:switchJava', severity: 'high' },
    ],
  },
  {
    id: 'no-such-method',
    pattern: /NoSuchMethodError|NoSuchFieldError|ClassNotFoundException|NoClassDefFoundError/,
    title: '模组或加载器版本不匹配',
    summary: '代码里调用了一个"不存在的方法/字段/类"——几乎总是：模组版本与 Minecraft、Forge/Fabric、或另一个模组的 API 对不上。',
    detail: 'NoSuchMethodError 最典型的是：1) 模组用了某 API 的新版本但当前是旧版；2) 加载器与游戏版本不匹配。请对照报错里的类名核对 mods 目录。',
    severity: 'medium',
    fixes: [
      { id: 'open-mods-nsm', label: '打开 mods 文件夹核对版本', description: '对照报错里提到的类名（如 net.fabricmc.fabric.*）确认模组版本与 MC 版本匹配。', action: 'fix:openModsFolder', severity: 'medium' },
    ],
  },
  {
    id: 'duplicate-mods',
    // 「Duplicate mod entries were skipped」是正常日志，必须有 found/detected/conflict 等错误上下文
    pattern: /DuplicateModIdException|duplicate (?:mod|jar)[^\n]{0,80}(?:found|detected|conflict|error|failed)|already exists[^\n]{0,40}mods/i,
    title: '重复的模组文件',
    summary: 'mods 目录里有同一个模组的多个版本同时存在（常见于手动更新模组后忘了删旧文件）。',
    detail: '重复模组会导致类加载冲突。MCL 的"模组体检"可以自动发现并隔离旧版本。',
    severity: 'medium',
    fixes: [
      { id: 'open-mods-dup', label: '打开 mods 文件夹并使用体检功能', description: '在「模组」页点「体检」，可以自动列出重复模组并一键隔离旧版本。', action: 'fix:openModsFolder', severity: 'medium' },
    ],
  },
  {
    id: 'module-access',
    pattern: /InaccessibleObjectException|IllegalAccessError|Unable to make field.*accessible|module java\.base/i,
    title: 'Java 模块限制',
    summary: 'Java 16+ 收紧了对内部 API 的访问，部分老模组 / 老加载器因此启动失败。',
    detail: '需要在 JVM 参数里加 --add-opens java.base/java.lang=ALL-UNNAMED 等开放项。',
    severity: 'medium',
    fixes: [
      { id: 'add-opens', label: '添加模块开放参数并重启', description: '在该实例的 JVM 附加参数中追加：--add-opens java.base/java.lang=ALL-UNNAMED', action: 'fix:addOpens', severity: 'medium' },
    ],
  },
  {
    id: 'shader-cache',
    // 「Cleared shader cache successfully」是正常维护日志，必须有损坏语义
    pattern: /shader[^\n]{0,80}(?:cache[^\n]{0,40}(?:corrupt|invalid|damaged|bad)|corrupt[^\n]{0,40}(?:cache|shader))|ShaderCompile[^\n]{0,120}(?:error|fail)|glsl[^\n]{0,80}error/i,
    title: '光影缓存损坏',
    summary: '光影的着色器缓存坏了。这种损坏会跨启动保留，只有手动清掉缓存才能恢复。',
    detail: 'OptiFine/Iris/Oculus 都会把编译好的 shader 缓存到游戏目录。损坏时游戏卡死在黑屏或持续报 shader 错误。',
    severity: 'medium',
    fixes: [
      { id: 'backup-restore', label: '先备份存档，再手动清除光影缓存', description: 'MCL 会立即创建一次完整备份。之后在游戏目录删除 .cache / shaderpacks 里对应的缓存文件夹即可。', action: 'fix:backupThenRestore', severity: 'medium' },
    ],
  },
  {
    id: 'killed-exit-137',
    // MCL 自己写的是中文「退出码 137」；旧正则只认英文写法，导致最常见的硬杀场景落到兜底
    pattern: /(?:(?:exit(?:ed)?\s*(?:code\s*)?|退出码)\D{0,4}\(?\s*137|signal\s*9\b|SIGKILL\b)/i,
    title: '游戏被系统强制结束',
    summary: 'Minecraft 进程被操作系统强制终止（exit code 137 / SIGKILL）。最常见原因是内存不足被系统 OOM Killer 回收，其次是整机内存吃紧或被手动关闭。',
    detail: 'Linux OOM Killer 在内存耗尽时按策略杀进程；Windows 也会强杀内存超限进程。表现为"日志直接中断、没有任何异常堆栈"。',
    severity: 'high',
    fixes: [
      { id: 'memory-heavy', label: '切换到「大型整合包 / 光影」预设', description: '更多初始与最大内存，降低被 OOM 强杀的概率。', action: 'fix:setMemoryPreset', args: { preset: 'heavy' }, severity: 'high' },
      { id: 'backup-137', label: '先备份存档', description: '修复前先创建一次完整备份，防止存档损坏。', action: 'fix:backupThenRestore', severity: 'medium' },
    ],
  },
  {
    id: 'connection-reset',
    // "handshake completed with remote peer" 是正常调试日志，不能单独命中失败规则
    // 裸「Connection refused」可能只是服务端满员提示；要求 ConnectException / SocketTimeout 上下文
    pattern: /(?:java\.net\.)?(?:ConnectException|SocketTimeoutException|SocketTimeout)[^\n]{0,120}(?:Connection refused|Connection reset|timed out)|Connection reset|handshake[^\n]{0,40}(?:fail|error|refus|timed out)|timed out[^\n]{0,40}connect/i,
    title: '网络连接失败',
    summary: '游戏连接服务器（或验证服务器）被对方拒绝或超时。联机时这可能是服务器挂了，也可能是你的验证通道不通。',
    detail: '常见：正版验证服务器暂时不可达、Java 8 过旧（TLS 1.3）、或本机防火墙/代理拦截。',
    severity: 'low',
    fixes: [
      { id: 'toggle-mirror', label: '切换下载镜像源', description: '设置 → 下载 → 镜像源，在 BMCLAPI 与官方源之间切换（国内网络建议 BMCLAPI）。', action: 'fix:toggleMirror', severity: 'low' },
    ],
  },
];

export function findLatestCrashReport(gameDir: string, since?: number): string | null {
  const dir = path.join(gameDir, 'crash-reports');
  if (!fs.existsSync(dir)) return null;
  let files = fs.readdirSync(dir).filter(f => f.endsWith('.txt')).map(f => path.join(dir, f));
  if (since) {
    // 只看本次启动期间产生的 crash report，避免旧报告覆盖本次错误归因
    const threshold = since - 5000;
    files = files.filter(f => { try { return fs.statSync(f).mtimeMs >= threshold; } catch { return false; } });
    if (files.length === 0) return null;
  }
  // 排序时文件可能已被其它程序清理：stat 失败按 0 处理，避免整个崩溃分析抛错
  const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  return files.sort((a, b) => mtime(b) - mtime(a))[0] ?? null;
}

function readTail(file: string, bytes = 512 * 1024): string {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - bytes);
  const buf = Buffer.alloc(stat.size - start);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

/**
 * 找该实例最近一次 MCL 启动日志，并读取其中的退出码。
 * 崩溃分析页会在页面打开时自动分析，如果最近一次是正常退出（退出码 0），
 * 就不应该再去 latest.log 里找网络警告，否则离线运行时 authlib 的
 * “Failed to verify authentication / Connect timed out” 会被误判成崩溃。
 */
function latestLaunchLog(instanceId: string): { file: string; startedAt: number; exitCode: number | null } | null {
  const dir = paths.logsDir();
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const safe = instanceId.replace(/[^a-zA-Z0-9_-]/g, '');
  const re = new RegExp(`^launch-${safe}-(\\d+)\\.log$`);
  let best: { file: string; startedAt: number } | null = null;
  for (const name of names) {
    const m = name.match(re);
    if (!m) continue;
    const startedAt = parseInt(m[1], 10);
    if (!Number.isFinite(startedAt)) continue;
    if (!best || startedAt > best.startedAt) best = { file: path.join(dir, name), startedAt };
  }
  if (!best) return null;
  let exitCode: number | null = null;
  try {
    const text = readTail(best.file, 128 * 1024);
    const exits = [...text.matchAll(/\[mcl\] 游戏进程退出，退出码 (-?\d+)/g)];
    if (exits.length > 0) exitCode = parseInt(exits[exits.length - 1][1], 10);
  } catch { /* 日志读不到时按未知处理 */ }
  return { ...best, exitCode };
}

/** 没有 crash-report 时，只有这些强证据才值得继续套崩溃规则 */
const STRONG_CRASH_EVIDENCE = /---- Minecraft Crash Report ----|---- Debug Crash Report ----|The game crashed|A fatal error has been detected|Exception in thread "main"|net\.minecraft\.crash/i;

/** authlib 在离线/验证服务器抖动时的提示不是崩溃原因，命中的行属于这类直接跳过该规则 */
function isBenignAuthLine(ruleId: string, text: string, idx: number): boolean {
  if (ruleId !== 'connection-reset') return false;
  const lineStart = text.lastIndexOf('\n', idx) + 1;
  const lineEnd = text.indexOf('\n', idx);
  const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
  return /authlib|Failed to verify authentication|com\.mojang\.authlib/i.test(line);
}

export function analyzeCrash(instanceId: string, logPath?: string, startedAt?: number): CrashDiagnosis {
  if (!/^[a-f0-9]{16}$/.test(String(instanceId ?? ''))) throw new Error('实例不存在');
  const game = paths.gameDir(instanceId);
  const launch = latestLaunchLog(instanceId);
  // 浏览器打开分析页时没有 startedAt：用最近一次启动时间过滤旧 crash-report，
  // 否则上上次的崩溃会一直覆盖本次「正常退出」的结果。
  const effectiveStartedAt = startedAt ?? launch?.startedAt;
  const crashReport = findLatestCrashReport(game, effectiveStartedAt);
  const logFallback = logPath ?? path.join(game, 'logs', 'latest.log');
  const sourceFile = crashReport ?? (launch?.exitCode === 0 ? launch.file : logFallback);

  // 最近一次由 MCL 启动且退出码为 0：没有崩溃，直接给出正常结果
  if (!crashReport && launch?.exitCode === 0) {
    return {
      matched: false,
      normal: true,
      title: '最近一次游戏正常退出',
      summary: '上次游戏是正常退出的（退出码 0），没有崩溃可以分析。启动日志里的 authlib 验证提示属于离线模式下的正常现象，不是错误。',
      detail: `已检查：${launch.file}`,
      fixes: [],
      sourceFile: launch.file,
      excerpt: '',
    };
  }

  let text = '';
  try { text = readTail(sourceFile); } catch {
    return {
      matched: false,
      title: '没有找到崩溃记录',
      summary: '还没有生成崩溃报告，或者游戏是被直接关掉的。',
      detail: `已检查：${sourceFile}`,
      fixes: [{ id: 'open-mods', label: '打开 mods 文件夹', description: '如果游戏是闪退后"什么都没留下"，先看看 mods 目录是否异常。', action: 'fix:openModsFolder', severity: 'low' }],
      sourceFile,
      excerpt: '',
    };
  }

  // 没有 crash-report、退出码也不明确（不是 MCL 启动或还没写到退出码）时，
  // 普通 latest.log 里的 authlib 警告 / 可恢复异常不能被当成崩溃。
  const mayHaveCrashed = !!crashReport
    || (typeof launch?.exitCode === 'number' && launch.exitCode !== 0)
    || STRONG_CRASH_EVIDENCE.test(text);
  if (!mayHaveCrashed) {
    return {
      matched: false,
      normal: true,
      title: '没有发现崩溃记录',
      summary: '这份日志里没有崩溃报告，也没有致命异常特征，最近一次运行看起来是正常的。离线模式下 authlib 的验证提示不算错误。',
      detail: `已检查：${sourceFile}`,
      fixes: [],
      sourceFile,
      excerpt: '',
    };
  }

  for (const rule of RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      const idx = Math.max(0, text.indexOf(m[0]));
      // authlib 在离线/验证服务器抖动时总会打印这些提示，游戏通常照常运行；
      // 只有真正的崩溃上下文才把网络规则算数，避免成功启动被误判成「网络连接失败」。
      if (isBenignAuthLine(rule.id, text, idx)) continue;
      const summary = typeof rule.summary === 'function' ? rule.summary(m) : rule.summary;
      const detail = typeof rule.detail === 'function' ? rule.detail(m) : rule.detail;
      const excerpt = text.slice(Math.max(0, idx - 200), Math.min(text.length, idx + 600));
      return {
        matched: true,
        ruleId: rule.id,
        title: rule.title,
        summary,
        detail,
        fixes: rule.fixes,
        sourceFile,
        excerpt,
      };
    }
  }

  // 兜底：给出关键行定位
  const keyLines = text.split(/\r?\n/).filter(l => /exception|error|caused by|fatal/i.test(l)).slice(-8).join('\n');
  return {
    matched: false,
    title: '出现了未知的崩溃',
    summary: 'MCL 没见过这种错误模式。下面是最关键的几行，你可以复制它们到社区或 Issue 区求助。',
    detail: '建议步骤：1）先点下方"先备份存档"；2）禁用最近新加的模组再试；3）导出诊断包并提交到 GitHub Issue。',
    fixes: [{ id: 'backup-restore', label: '先备份存档', description: '修复前先创建一次完整备份，防止进一步损坏存档。', action: 'fix:backupThenRestore', severity: 'medium' }],
    sourceFile,
    excerpt: keyLines || text.slice(-1500),
  };
}

/** 分析一段用户粘贴的日志文本 */
export function analyzeLogText(text: string): CrashDiagnosis {
  for (const rule of RULES) {
    const m = text.match(rule.pattern);
    if (m) {
      const idx = Math.max(0, text.indexOf(m[0]));
      // 粘贴一段正常的离线日志时，authlib 的验证提示同样不算网络崩溃
      if (isBenignAuthLine(rule.id, text, idx)) continue;
      const summary = typeof rule.summary === 'function' ? rule.summary(m) : rule.summary;
      const detail = typeof rule.detail === 'function' ? rule.detail(m) : rule.detail;
      return {
        matched: true,
        ruleId: rule.id,
        title: rule.title,
        summary,
        detail,
        fixes: rule.fixes,
        sourceFile: '(粘贴的文本)',
        excerpt: text.slice(Math.max(0, idx - 200), Math.min(text.length, idx + 600)),
      };
    }
  }
  return {
    matched: false,
    title: '没有匹配到已知错误模式',
    summary: '这段日志里 MCL 没识别出典型错误。把完整日志导出后贴到社区求助效率更高。',
    detail: '提示：关注 "Caused by:" 后面的第一行，通常是真正的原因。',
    fixes: [],
    sourceFile: '(粘贴的文本)',
    excerpt: text.slice(-1500),
  };
}
