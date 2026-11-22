#!/usr/bin/env node
/**
 * 零依赖打包脚本：把已构建的 dist/ 与 electron-dist/ 塞进 Electron 运行时，生成免安装目录 + ZIP。
 *
 * 用法：
 *   npm run package:dir        # 构建后执行（package:dir 脚本会先跑 build）
 *   node scripts/package.js    # 直接使用现有构建产物
 *   node scripts/package.js --no-zip   # 只生成目录，不压 ZIP
 *
 * 注意：默认的 npm run package 现在走 electron-builder 生成单文件便携 exe；
 * 本脚本保留为零依赖、可审计的目录/ZIP 打包备选。
 *
 * 产物：
 *   release/MCL-<版本>-win32-x64/      免安装目录（双击 MCL.exe 启动）
 *   release/MCL-<版本>-win32-x64.zip   可分发的便携压缩包
 *
 * 说明：
 * - 不引入 electron-builder，保持主进程零第三方依赖的信任卖点；
 * - 不生成安装器（NSIS/MSI），避免签名与提权问题；
 * - 需要先执行 npm install 且 Electron 二进制已下载（npm run dev 的 predev 会自愈）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const releaseRoot = path.join(root, 'release');
const wantZip = !process.argv.includes('--no-zip');

function fail(message) {
  console.error(`\n[package] 失败：${message}\n`);
  process.exit(1);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail(`无法读取 ${path.relative(root, file)}`); }
}

const pkg = readJson(path.join(root, 'package.json'));
const electronPkgPath = path.join(root, 'node_modules', 'electron', 'package.json');
const electronVersion = fs.existsSync(electronPkgPath) ? readJson(electronPkgPath).version : null;
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const rendererDist = path.join(root, 'dist');
const mainDist = path.join(root, 'electron-dist');

if (!fs.existsSync(rendererDist)) fail('缺少 dist/，请先运行 npm run build');
if (!fs.existsSync(mainDist)) fail('缺少 electron-dist/，请先运行 npm run build');
if (!fs.existsSync(electronDist)) {
  fail('缺少 node_modules/electron/dist（Electron 二进制未下载）。\n先运行 npm run dev 触发 predev 自愈，或手动执行 node node_modules/electron/install.js');
}

const platform = process.platform;
const arch = process.arch;
const outName = `MCL-${pkg.version}-${platform}-${arch}`;
const outDir = path.join(releaseRoot, outName);

console.log(`[package] Electron ${electronVersion ?? '?'} · ${platform}-${arch}`);
console.log(`[package] 输出目录：${outDir}`);

fs.mkdirSync(releaseRoot, { recursive: true });
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// 1. 复制 Electron 运行时
fs.cpSync(electronDist, outDir, { recursive: true });

// 2. 可执行文件改名：macOS 的可执行体在 Electron.app 内，不能按裸 electron 查找
const isWin = platform === 'win32';
const isMac = platform === 'darwin';
const exeName = isWin ? 'electron.exe' : 'electron';
const appExe = path.join(outDir, exeName);
if (fs.existsSync(appExe)) {
  const targetExe = path.join(outDir, isWin ? 'MCL.exe' : 'MCL');
  fs.renameSync(appExe, targetExe);
} else if (!isMac) {
  console.warn(`[package] 警告：未找到 ${exeName}，可执行文件名保持原样`);
}
// macOS 不重命名 Electron.app：改名会破坏 .app 内部结构（签名/Info.plist 引用）

// 3. 放入应用代码：macOS 必须从 Electron.app/Contents/Resources/app 加载
const resourcesDir = isMac ? path.join(outDir, 'Electron.app', 'Contents', 'Resources') : path.join(outDir, 'resources');
const appDir = path.join(resourcesDir, 'app');
fs.mkdirSync(appDir, { recursive: true });
fs.cpSync(rendererDist, path.join(appDir, 'dist'), { recursive: true });
fs.cpSync(mainDist, path.join(appDir, 'electron-dist'), { recursive: true });
// 应用图标（窗口/任务栏），与源码 assets/ 保持一致
const assetsSource = path.join(root, 'assets');
if (fs.existsSync(assetsSource)) fs.cpSync(assetsSource, path.join(appDir, 'assets'), { recursive: true });

// Electron 自带的默认应用会影响启动，移除更干净
for (const legacy of ['default_app.asar', 'default_app']) {
  fs.rmSync(path.join(resourcesDir, legacy), { recursive: true, force: true });
}

// 运行时只需要 main / version；依赖为零，无需 node_modules
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: 'mcl',
  version: pkg.version,
  description: pkg.description,
  main: 'electron-dist/main.js',
  license: pkg.license,
  engines: pkg.engines,
}, null, 2), 'utf8');

// 4. 便携说明 + 便携模式开关示例
fs.writeFileSync(path.join(outDir, '使用说明.txt'), [
  'MCL · 新一代我的世界启动器',
  '',
  `版本：${pkg.version}`,
  `运行时：Electron ${electronVersion ?? '（未知）'} / ${platform}-${arch}`,
  '',
  `启动：${isWin ? '双击 MCL.exe' : isMac ? '双击 Electron.app（这是 MCL 的 macOS 应用包）' : '在终端运行 ./MCL'}`,
  '',
  '便携模式：',
  '  在本目录新建一个空的 portable.txt 文件，数据会保存到同目录的 mcl-data/，',
  `  不再写入 ${isWin ? '%APPDATA%' : isMac ? '~/Library/Application Support' : '~/.config'}。删除 portable.txt 即恢复默认。`,
  '',
  '首次启动会按需下载：',
  '  - Minecraft 版本清单、游戏本体、共享库与资源',
  '  - 匹配的 Java（Adoptium Temurin）',
  '下载源可在「设置 → 下载与镜像」里切换；网络不稳定可在「设置 → 网络代理」配置 HTTP 代理。',
  '',
  '安全说明：',
  '  - 无遥测、不收集账号密码；微软登录令牌只保存在本机数据目录。',
  '  - 更新只下载到系统下载目录，不会自动替换程序文件。',
  '',
  '开源协议：MIT · https://github.com/MistHowlJade/mcl',
  '',
].join('\n'), 'utf8');

console.log('[package] 已生成免安装目录');

// 5. 用项目自带的零依赖 ZIP 实现打包（避免引入 archiver 等依赖）
if (wantZip) {
  const zipModule = path.join(mainDist, 'services', 'zip.js');
  if (!fs.existsSync(zipModule)) fail('缺少 electron-dist/services/zip.js，无法生成 ZIP');
  const { zipFromDir } = require(zipModule);
  const zipPath = path.join(releaseRoot, `${outName}.zip`);
  fs.rmSync(zipPath, { force: true });
  console.log('[package] 正在压缩（大文件需要一点时间）…');
  const buffer = zipFromDir(outDir);
  fs.writeFileSync(zipPath, buffer);
  const mb = (buffer.length / 1024 / 1024).toFixed(1);
  console.log(`[package] 已生成 ZIP：${zipPath}（${mb} MB）`);
}

console.log('\n[package] 完成。分发时发送 release/ 下的目录或 ZIP 即可。');