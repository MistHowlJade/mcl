/**
 * 启动参数预览：展示可编辑的 JVM 配置与最终命令骨架。
 * 不解析版本 JSON / 不下载文件，因此可以在启动前安全预览；classpath 与游戏参数用占位符表示。
 */
import * as instances from './instances';
import * as javaService from './java';
import { getSettings } from './settings';
import { MEMORY_PRESETS } from './minecraft';
import { proxyJvmArgs } from './proxy';
import { LaunchArgGroup, LaunchPreview, MemoryPreset } from '../shared/types';

function tokens(value: string): string[] {
  return String(value ?? '').split(/\s+|\n+/).map(s => s.trim()).filter(Boolean);
}

function isHeapMB(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 256 && value <= 65536;
}

function group(id: string, label: string, explain: string, args: string[]): LaunchArgGroup {
  return { id, label, explain, args };
}

export async function previewLaunch(instanceId: string): Promise<LaunchPreview> {
  const instance = instances.getInstance(instanceId);
  if (!instance) throw new Error('实例不存在');
  const settings = getSettings();
  const recommended = javaService.recommendedJavaMajor(instance.mcVersion);
  const picked = await javaService.pickJavaFor(
    instance.mcVersion,
    instance.javaPath || settings.java.defaultPath || null,
    null,
  );

  const presetKey: MemoryPreset = (instance.memoryPreset as MemoryPreset) || 'standard';
  const preset = MEMORY_PRESETS[presetKey] || MEMORY_PRESETS.standard;
  const hasCustomHeap = isHeapMB(instance.heapInitialMB) && isHeapMB(instance.heapMaxMB)
    && (instance.heapInitialMB as number) <= (instance.heapMaxMB as number);
  const memory = hasCustomHeap
    ? { initial: `${instance.heapInitialMB}M`, max: `${instance.heapMaxMB}M`, label: '自定义堆' }
    : { initial: preset.initial, max: preset.max, label: preset.label };

  const groups: LaunchArgGroup[] = [
    group('memory', '内存', '初始堆与最大堆。填太大会导致系统换页甚至被强杀，建议不超过物理内存的 70%。',
      [`-Xms${memory.initial}`, `-Xmx${memory.max}`]),
  ];
  if (preset.gc.length) {
    groups.push(group('gc', '垃圾回收', '大型整合包 / 光影预设：G1GC 与低停顿参数，减少卡顿尖峰。', preset.gc));
  }

  const compatibility: string[] = [];
  if (settings.launch.utf8Encoding) compatibility.push('-Dfile.encoding=UTF-8', '-Dsun.jnu.encoding=UTF-8');
  const isOldMc = /^1\.([0-9]|1[0-6])(\.|$)/.test(instance.mcVersion);
  if (settings.launch.log4jFix && isOldMc) compatibility.push('-Dlog4j2.formatMsgNoLookups=true');
  if (compatibility.length) {
    groups.push(group('compat', '兼容性', 'UTF-8 编码与旧版 Minecraft 的 Log4j 安全缓解参数。', compatibility));
  }

  const instanceArgs = tokens(instance.jvmArgsExtra || '');
  if (instanceArgs.length) groups.push(group('instance', '实例附加参数', '只对当前实例生效，优先级在内存预设之后。', instanceArgs));
  const globalArgs = tokens(settings.launch.globalJvmArgs || '');
  if (globalArgs.length) groups.push(group('global', '全局附加参数', '对所有实例生效，在实例参数之后追加。', globalArgs));

  const proxyArgs = proxyJvmArgs();
  if (proxyArgs.length) groups.push(group('proxy', '网络代理', '设置 → 网络里启用的代理，会同时注入游戏 JVM。', proxyArgs));

  const allArgs = groups.flatMap(item => item.args);
  const command = `${picked?.java?.path || '<未找到 Java>'} ${allArgs.join(' ')} <classpath> <主类> <游戏参数>`.replace(/\s+/g, ' ').trim();

  return {
    instanceId,
    instanceName: instance.name,
    javaPath: picked?.java?.path ?? null,
    recommendedJavaMajor: recommended,
    memory,
    groups,
    command,
    notes: [
      'classpath、主类与游戏参数由版本 JSON 决定，启动时自动展开，这里用占位符表示。',
      presetKey === 'heavy' ? '当前是「大型整合包 / 光影」预设，GC 参数较多属于正常现象。' : '普通游玩不建议堆内存超过 4G。',
    ],
  };
}
