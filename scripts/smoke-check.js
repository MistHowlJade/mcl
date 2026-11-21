/**
 * smoke-check.js — 不依赖游戏运行的逻辑冒烟（对应 issues #1/#8/#10/#11 的回归保护）
 * 运行：node scripts/smoke-check.js（需要先 npm run build 生成 electron-dist/）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
};

const dist = path.join(__dirname, '..', 'electron-dist', 'services');
const version = require(path.join(dist, 'version.js'));
const net = require(path.join(dist, 'net.js'));
const migrate = require(path.join(dist, 'migrate.js'));
const crash = require(path.join(dist, 'crash.js'));
const java = require(path.join(dist, 'java.js'));
const zip = require(path.join(dist, 'zip.js'));

console.log('== evalRules / evalRule（issue #1）==');
check('allow + disallow(osx) 在非 macOS 生效（应为 true）', () => {
  assert.strictEqual(version.evalRules([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }]), true);
});
check('disallow(linux) 在 Linux 生效（应为 false）', () => {
  const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  assert.strictEqual(version.evalRules([{ action: 'disallow', os: { name: osName } }]), false);
});
check('无条件 allow 应为 true', () => {
  assert.strictEqual(version.evalRules([{ action: 'allow' }]), true);
});
check('无 rules 应为 true', () => {
  assert.strictEqual(version.evalRules(undefined), true);
});
check('features 不匹配则规则不生效', () => {
  assert.strictEqual(version.evalRules([{ action: 'allow', features: { is_demo_user: true } }], { is_demo_user: false }), false);
  assert.strictEqual(version.evalRules([{ action: 'allow', features: { is_demo_user: true } }], { is_demo_user: true }), true);
});
check('collectLibraries 保留 1.12.2 LWJGL 2 库（issue #1 原始复现）', () => {
  const resolved = {
    libraries: [
      { name: 'org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209', rules: [{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], downloads: { artifact: { path: 'org/lwjgl/lwjgl/2.9.4-nightly-20150209/lwjgl-2.9.4-nightly-20150209.jar', url: 'https://libraries.minecraft.net/x.jar', sha1: 'abc', size: 100 } } },
      { name: 'org.lwjgl.lwjgl:lwjgl:2.9.2-nightly-20140822', rules: [{ action: 'allow' }, { action: 'disallow', os: { name: 'windows' } }], downloads: { artifact: { path: 'y.jar', url: 'https://libraries.minecraft.net/y.jar', sha1: 'def', size: 100 } } },
    ],
  };
  const libs = version.collectLibraries(resolved);
  const names = libs.map(l => l.name);
  if (process.platform !== 'win32') {
    assert.ok(names.includes('org.lwjgl.lwjgl:lwjgl:2.9.4-nightly-20150209'), 'lwjgl 2.9.4 应被保留');
    assert.ok(names.includes('org.lwjgl.lwjgl:lwjgl:2.9.2-nightly-20140822'), 'lwjgl 2.9.2 非 Windows 应被保留');
  } else {
    assert.ok(!names.includes('org.lwjgl.lwjgl:lwjgl:2.9.2-nightly-20140822'), 'lwjgl 2.9.2 仅 disallow windows 时应被排除');
  }
});

console.log('== mapToMirror（issue #11）==');
check('piston-data 不应带 /piston-data 前缀', () => {
  assert.strictEqual(net.mapToMirror('https://piston-data.mojang.com/v1/objects/abc/def.json', 'bmclapi'), 'https://bmclapi2.bangbang93.com/v1/objects/abc/def.json');
});
check('repo.maven.apache.org /maven2 前缀应被剥离', () => {
  assert.strictEqual(net.mapToMirror('https://repo.maven.apache.org/maven2/org/lwjgl/a.jar', 'bmclapi'), 'https://bmclapi2.bangbang93.com/libraries/org/lwjgl/a.jar');
});
check('libraries.minecraft.net 保留路径', () => {
  assert.strictEqual(net.mapToMirror('https://libraries.minecraft.net/org/lwjgl/a.jar', 'bmclapi'), 'https://bmclapi2.bangbang93.com/libraries/org/lwjgl/a.jar');
});
check('Forge/NeoForge Maven 不映射到 BMCLAPI', () => {
  const u = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml';
  assert.strictEqual(net.mapToMirror(u, 'bmclapi'), u);
});
check('Fabric Maven 镜像带 /maven 前缀', () => {
  assert.strictEqual(net.mapToMirror('https://maven.fabricmc.net/net/fabricmc/fabric-api/fabric-api/0.91.0/fabric-api-0.91.0.jar', 'bmclapi').includes('/maven/net/fabricmc/'), true);
});
check('assets 使用 sha1 全路径', () => {
  assert.strictEqual(net.mapToMirror('https://resources.download.minecraft.net/ab/abcdef', 'bmclapi'), 'https://bmclapi2.bangbang93.com/assets/abcdef');
});

console.log('== parseVersionName / compareMcVersions（issue #8）==');
check('fabric-loader-0.15.7-1.20.4 → MC 1.20.4', () => {
  const r = migrate.parseVersionName('fabric-loader-0.15.7-1.20.4');
  assert.strictEqual(r.mcVersion, '1.20.4');
  assert.strictEqual(r.loader, 'fabric');
  assert.strictEqual(r.loaderVersion, '0.15.7');
});
check('quilt-loader-0.23.1-1.20.1 → MC 1.20.1', () => {
  const r = migrate.parseVersionName('quilt-loader-0.23.1-1.20.1');
  assert.strictEqual(r.mcVersion, '1.20.1');
  assert.strictEqual(r.loader, 'quilt');
  assert.strictEqual(r.loaderVersion, '0.23.1');
});
check('1.12.2 → MC 1.12.2 vanilla', () => {
  const r = migrate.parseVersionName('1.12.2');
  assert.strictEqual(r.mcVersion, '1.12.2');
  assert.strictEqual(r.loader, 'vanilla');
});
check('1.20.1-forge-47.2.0 → MC 1.20.1 forge', () => {
  const r = migrate.parseVersionName('1.20.1-forge-47.2.0');
  assert.strictEqual(r.mcVersion, '1.20.1');
  assert.strictEqual(r.loader, 'forge');
  assert.strictEqual(r.loaderVersion, '47.2.0');
});
check('语义版本比较：1.20.1 > 1.9', () => {
  assert.ok(migrate.compareMcVersions('1.20.1', '1.9') > 0);
  assert.ok(migrate.compareMcVersions('1.9', '1.20.1') < 0);
  assert.strictEqual(migrate.compareMcVersions('1.20.1', '1.20.1'), 0);
});

console.log('== 崩溃归因（issue #13）==');
check('GLFW error 归因 opengl 而非 natives-lwjgl', () => {
  assert.strictEqual(crash.analyzeLogText('GLFW error 65543: Failed to create OpenGL context').ruleId, 'opengl');
});
check('exit code 137 归因 killed-exit-137', () => {
  assert.strictEqual(crash.analyzeLogText('Process finished with exit code 137').ruleId, 'killed-exit-137');
});
check('class file version 61.0 归因 unsupported-class-version', () => {
  assert.strictEqual(crash.analyzeLogText('java.lang.UnsupportedClassVersionError: Foo has been compiled by a more recent version of the Java Runtime (class file version 61.0), this version of the Java Runtime only recognizes class file versions up to 52.0').ruleId, 'unsupported-class-version');
});

console.log('== 本轮修复回归 ==');
const NATIVE_OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
check('旧版只有 natives 的幻影库不生成 404 主 jar 任务', () => {
  const resolved = { libraries: [{ name: 'tv.twitch:twitch-platform:5.16', natives: { [NATIVE_OS]: `natives-${NATIVE_OS}-\${arch}` } }] };
  const libs = version.collectLibraries(resolved);
  assert.strictEqual(libs.filter(l => !l.isNative).length, 0);
  assert.ok(libs.some(l => l.isNative));
});
check('旧版 natives ${arch} 占位符按 CPU 架构展开', () => {
  const arch = process.arch === 'ia32' ? '32' : process.arch === 'arm64' ? 'arm64' : '64';
  const resolved = { libraries: [{ name: 'tv.twitch:twitch-platform:5.16', natives: { [NATIVE_OS]: `natives-${NATIVE_OS}-\${arch}` } }] };
  const libs = version.collectLibraries(resolved);
  assert.ok(libs.some(l => l.path.includes(`natives-${NATIVE_OS}-${arch}.jar`)), `应展开为 ${arch} 位 natives`);
  assert.ok(!libs.some(l => l.path.includes('${arch}')), '不应残留未展开的占位符');
});
check('Java 8u291 排序新于 8u202', () => {
  assert.ok(java.compareVersionDesc('1.8.0_291', '1.8.0_202') < 0);
  assert.ok(java.compareVersionDesc('1.8.0_202', '1.8.0_291') > 0);
});
check('26.x 与快照版本推荐 Java 25/21', () => {
  assert.strictEqual(java.recommendedJavaMajor('26.3'), 25);
  assert.strictEqual(java.recommendedJavaMajor('26.4-snapshot-8'), 25);
  assert.strictEqual(java.recommendedJavaMajor('24w14a'), 21);
  assert.strictEqual(java.recommendedJavaMajor('23w51a'), 21);
  assert.strictEqual(java.recommendedJavaMajor('1.20.1'), 17);
});
check('中文「退出码 137」能命中强杀诊断', () => {
  assert.strictEqual(crash.analyzeLogText('[mcl] 游戏进程退出，退出码 137').ruleId, 'killed-exit-137');
});
check('离线日志里的 authlib 验证提示不算网络崩溃', () => {
  const text = '[Render thread/INFO]: [com.mojang.authlib.minecraft.MinecraftSessionService/4a1]: Connection refused';
  assert.notStrictEqual(crash.analyzeLogText(text).ruleId, 'connection-reset');
});
check('崩溃归因不误报正常日志', () => {
  assert.notStrictEqual(crash.analyzeLogText('Loading Minecraft 1.20.0\nReading class file cache').ruleId, 'unsupported-class-version');
  assert.notStrictEqual(crash.analyzeLogText('handshake completed with remote peer').ruleId, 'connection-reset');
});
check('Fabric 缺前置句式能命中', () => {
  assert.strictEqual(crash.analyzeLogText("Mod 'Sodium' requires version 0.5.0 of 'Fabric API', which is missing!").ruleId, 'missing-dependency');
});
check('ZIP 指定前缀只解压该子树', () => {
  const buf = zip.zipWrite([
    { name: 'world/level.dat', data: Buffer.from('x') },
    { name: 'screenshots/pic.png', data: Buffer.from('y') },
  ]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-zip-'));
  try {
    const written = zip.zipExtractAll(buf, dir, 'world/');
    assert.strictEqual(written.length, 1);
    assert.ok(fs.existsSync(path.join(dir, 'level.dat')));
    assert.ok(!fs.existsSync(path.join(dir, 'screenshots')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
check('退出码 0 的离线日志不判成网络崩溃（issue #35）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-crash-'));
  const oldHome = process.env.MCL_HOME;
  process.env.MCL_HOME = root;
  try {
    const id = 'a'.repeat(16);
    const gameLogs = path.join(root, 'instances', id, 'game', 'logs');
    fs.mkdirSync(gameLogs, { recursive: true });
    fs.writeFileSync(path.join(gameLogs, 'latest.log'), [
      '[Render thread/INFO]: [com.mojang.authlib.minecraft.MinecraftSessionService/1a2b]: Failed to verify authentication',
      'java.net.ConnectException: Connect timed out',
      '[Render thread/INFO]: Stopping!',
    ].join('\n'));
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs', `launch-${id}-1700000000000.log`), '[mcl] 游戏进程退出，退出码 0\n');
    const d = crash.analyzeCrash(id);
    assert.strictEqual(d.normal, true, '退出码 0 应直接判为正常退出');
    assert.notStrictEqual(d.ruleId, 'connection-reset');
  } finally {
    if (oldHome === undefined) delete process.env.MCL_HOME;
    else process.env.MCL_HOME = oldHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 异步用例（issue #45）：模拟 Node happy-eyeballs 抛出的 AggregateError（message 为空）
(async () => {
  const paths = require(path.join(dist, 'paths.js'));
  const cacheFile = path.join(paths.cacheDir(), 'version_manifest.json');
  const hadCache = fs.existsSync(cacheFile);
  if (hadCache) fs.renameSync(cacheFile, `${cacheFile}.smoke-backup`);
  const originalFetchJson = net.fetchJson;
  try {
    net.fetchJson = () => {
      const e = new AggregateError([], '');
      e.code = 'ETIMEDOUT';
      throw e;
    };
    let message = '';
    try { await version.getVersionManifest('official'); }
    catch (e) { message = e instanceof Error ? e.message : String(e); }
    check('AggregateError 空 message 时版本清单错误仍有原因（issue #45）', () => {
      assert.ok(!message.includes('：。'), `不应出现空原因：${message}`);
      assert.ok(message.includes('ETIMEDOUT'), `应回退到错误 code：${message}`);
    });
  } finally {
    net.fetchJson = originalFetchJson;
    if (hadCache) fs.renameSync(`${cacheFile}.smoke-backup`, cacheFile);
  }
  check('errorReason 对常见异常形态都给出非空人话', () => {
    assert.strictEqual(net.errorReason(new Error('代理 CONNECT 失败（HTTP 502）')), '代理 CONNECT 失败（HTTP 502）');
    assert.strictEqual(net.errorReason(new AggregateError([new Error('connect EHOSTUNREACH')], '')), 'connect EHOSTUNREACH');
    assert.strictEqual(net.errorReason(null), '未知错误');
  });

  const zipRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-zip64-'));
  try {
    const small = path.join(zipRoot, 'small.txt');
    fs.writeFileSync(small, 'hello');
    const big = path.join(zipRoot, 'big.bin');
    fs.writeFileSync(big, Buffer.alloc(5 * 1024 * 1024, 7));
    const stored = path.join(zipRoot, 'stored.bin');
    fs.writeFileSync(stored, Buffer.alloc(1024 * 1024, 3));
    const zipPath = path.join(zipRoot, 'out.zip');
    await zip.zipWriteToFile([
      { name: 'dir/small.txt', absPath: small, size: 5 },
      { name: 'big.bin', absPath: big, size: 5 * 1024 * 1024 },
      { name: 'stored.bin', absPath: stored, store: true },
    ], zipPath);
    const buf = fs.readFileSync(zipPath);
    const list = zip.zipList(buf);
    check('流式 ZIP 写入后可被自己列出并解压（#18/#28）', () => {
      assert.strictEqual(list.length, 3);
      assert.strictEqual(zip.zipExtractEntry(buf, list[0]).toString(), 'hello');
      assert.ok(zip.zipExtractEntry(buf, list[1]).every(b => b === 7));
      assert.ok(zip.zipExtractEntry(buf, list[2]).every(b => b === 3));
    });
    const extractDir = path.join(zipRoot, 'out');
    const written = zip.zipExtractAll(buf, extractDir);
    check('流式 ZIP 解压落盘路径与内容正确', () => {
      assert.strictEqual(written.length, 3);
      assert.strictEqual(fs.readFileSync(path.join(extractDir, 'dir', 'small.txt'), 'utf8'), 'hello');
    });

    const fileList = await zip.zipListFromFile(zipPath);
    check('流式 ZIP 可从文件直接列出中央目录（不读整包）', () => {
      assert.strictEqual(fileList.length, 3);
      assert.strictEqual(fileList[0].name, 'dir/small.txt');
    });
    const fileExtractDir = path.join(zipRoot, 'file-out');
    const fileWritten = await zip.zipExtractAllFromFile(zipPath, fileExtractDir);
    check('流式 ZIP 可从文件流式解压且内容一致', () => {
      assert.strictEqual(fileWritten.length, 3);
      assert.strictEqual(fs.readFileSync(path.join(fileExtractDir, 'dir', 'small.txt'), 'utf8'), 'hello');
      assert.strictEqual(fs.readFileSync(path.join(fileExtractDir, 'big.bin')).length, 5 * 1024 * 1024);
    });

    const manyPath = path.join(zipRoot, 'many.zip');
    const many = [];
    for (let i = 0; i < 70000; i++) many.push({ name: `f${i}.txt`, absPath: small, size: 5, mtime: new Date(2020, 0, 1) });
    await zip.zipWriteToFile(many, manyPath);
    const manyBuf = fs.readFileSync(manyPath);
    check('ZIP64：70000 条目可写可列出（#28）', () => {
      const l = zip.zipList(manyBuf);
      assert.strictEqual(l.length, 70000);
      assert.strictEqual(zip.zipExtractEntry(manyBuf, l[69999]).toString(), 'hello');
    });
    const fileMany = await zip.zipListFromFile(manyPath);
    check('ZIP64：70000 条目也可从文件流式列出', () => {
      assert.strictEqual(fileMany.length, 70000);
    });

    const forcedPath = path.join(zipRoot, 'forced64.zip');
    await zip.zipWriteToFile([
      { name: 'a.txt', absPath: small, size: 5, mtime: new Date(2020, 0, 1) },
    ], forcedPath, { zip64: true });
    check('ZIP64：强制 ZIP64 模式的小包仍可正常读取', () => {
      assert.strictEqual(zip.zipList(fs.readFileSync(forcedPath)).length, 1);
    });
  } finally {
    fs.rmSync(zipRoot, { recursive: true, force: true });
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
