/**
 * ensure-electron.js — `npm run dev` 前自动补齐 Electron 二进制
 * 背景：npm v11 默认拦截 postinstall，导致 Electron 不会自动下载二进制；
 * 加上官方源慢/超时，换电脑首次运行必炸。这里自愈：
 * 1. 二进制已存在 → 直接跳过
 * 2. 从 npmmirror（国内最快）下载，官方源兜底
 * 3. 解压到 node_modules/electron/dist + 写 path.txt
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exeName = isWin ? 'electron.exe' : isMac ? 'Electron' : 'electron';
const pathTxt = path.join(electronDir, 'path.txt');

function log(msg) { console.log(`[ensure-electron] ${msg}`); }

// 1) 已经齐了就不动了
if (fs.existsSync(path.join(distDir, exeName)) && fs.existsSync(pathTxt)) {
  log('Electron 二进制已就绪，跳过。');
  process.exit(0);
}
if (!fs.existsSync(electronDir)) {
  console.error('[ensure-electron] 未找到 node_modules/electron，请先执行 npm install');
  process.exit(1);
}

// 2) 读版本号
const pkg = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf8'));
const version = pkg.version;
const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
const platform = isWin ? 'win32' : isMac ? 'darwin' : 'linux';
const fileName = `electron-v${version}-${platform}-${arch}.zip`;
log(`Electron v${version} (${platform}-${arch}) 二进制缺失，开始下载…`);

const MIRRORS = [
  process.env.ELECTRON_MIRROR ? process.env.ELECTRON_MIRROR.replace(/\/+$/, '') + `/${version}/${fileName}` : null,
  `https://npmmirror.com/mirrors/electron/${version}/${fileName}`,
  `https://github.com/electron/electron/releases/download/v${version}/${fileName}`,
].filter(Boolean);

const cacheRoot = process.env[isWin ? 'LOCALAPPDATA' : 'HOME'] || require('os').homedir();
const cacheDir = path.join(cacheRoot, 'electron', 'Cache');
fs.mkdirSync(cacheDir, { recursive: true });
const zipPath = path.join(cacheDir, `${Date.now()}-${fileName}`);

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多'));
    const req = https.get(url, { headers: { 'User-Agent': 'mcl-ensure-electron' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('下载超时')); });
    req.on('error', reject);
  });
}

(async () => {
  let lastErr = null;
  for (const url of MIRRORS) {
    try {
      log(`下载：${url}`);
      await download(url, zipPath);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      log(`源失败（${e.message}），尝试下一个源…`);
    }
  }
  if (lastErr) { console.error(`[ensure-electron] 全部源下载失败：${lastErr.message}`); process.exit(1); }

  // 3) 解压
  log('解压中…');
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });
  if (isWin) {
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${distDir}' -Force"`, { stdio: 'inherit' });
  } else {
    execSync(`unzip -o '${zipPath}' -d '${distDir}'`, { stdio: 'inherit' });
  }
  fs.unlinkSync(zipPath);
  fs.writeFileSync(pathTxt, exeName, 'utf8');
  log('完成，可以运行 npm run dev 了。');
})().catch(e => {
  console.error(`[ensure-electron] 失败：${e.message || e}`);
  process.exit(1);
});
