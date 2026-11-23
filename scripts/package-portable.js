#!/usr/bin/env node
/**
 * 单文件便携版打包封装。
 *
 * 为什么需要封装：
 * 1. electron-builder 默认的 NSIS 3.0.4.1 在本项目 ~400MB 的单文件包上会报
 *    "Internal compiler error #12345: error creating mmap"，改用镜像上的 3.0.5.0；
 * 2. 该 NSIS 放在含中文的工程路径下同样会 mmap 失败，因此固定解压到系统临时目录（纯 ASCII 路径）；
 * 3. NSIS 输出目录也用 ASCII 的 portable/，成功后改名为中文「便携版」，与另两个版本排在一起。
 *
 * 用法：node scripts/package-portable.js（npm run package 会先构建再调用本脚本）
 */
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nsisVersion = '3.0.5.0';
const nsisDir = path.join(os.tmpdir(), `mcl-nsis-${nsisVersion}`);
const nsisUrl = `https://npmmirror.com/mirrors/electron-builder-binaries/nsis-${nsisVersion}/nsis-${nsisVersion}.7z`;
const stageDir = path.join(root, 'release', 'versions', 'portable');
const finalDir = path.join(root, 'release', 'versions', '便携版');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function run(command, args, options = {}) {
  const result = cp.spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status}`);
}

async function ensureNsis() {
  const exe = path.join(nsisDir, 'Bin', 'makensis.exe');
  if (fs.existsSync(exe)) return;

  console.log(`[package] 下载 NSIS ${nsisVersion} → ${nsisDir}`);
  const res = await fetch(nsisUrl);
  if (!res.ok) throw new Error(`下载 NSIS 失败：HTTP ${res.status}`);
  const archive = path.join(os.tmpdir(), `mcl-nsis-${nsisVersion}.7z`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  fs.rmSync(nsisDir, { recursive: true, force: true });
  fs.mkdirSync(nsisDir, { recursive: true });
  // Windows 10+ 自带 bsdtar，可直接解 7z；不引入任何 npm 依赖
  run('tar', ['-xf', archive, '-C', nsisDir]);
  fs.rmSync(archive, { force: true });
  if (!fs.existsSync(exe)) throw new Error('NSIS 解压后缺少 Bin/makensis.exe');
}

(async () => {
  try {
    await ensureNsis();

    const env = {
      ...process.env,
      ELECTRON_CACHE: '.build-cache/electron',
      ELECTRON_BUILDER_CACHE: '.build-cache/electron-builder',
      ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
      ELECTRON_BUILDER_NSIS_DIR: nsisDir,
    };
    // 直接以 Node 运行 CLI，避开中文工程路径下 .cmd 启动器与 shell 的编码问题
    const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
    run(process.execPath, [cli, '--win', 'portable', '--config', 'electron-builder.yml'], { env });

    const exeName = `MCL-${version}-portable-x64.exe`;
    if (!fs.existsSync(path.join(stageDir, exeName))) throw new Error('未找到生成的便携版 exe');

    // 只保留 exe；win-unpacked 是中间产物，与稳定版目录重复且占 ~270MB
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.rmSync(path.join(stageDir, 'win-unpacked'), { recursive: true, force: true });
    fs.renameSync(stageDir, finalDir);

    console.log(`[package] 便携版已生成：${path.join(finalDir, exeName)}`);
  } catch (error) {
    console.error(`\n[package] 失败：${error.message || error}\n`);
    process.exit(1);
  }
})();
