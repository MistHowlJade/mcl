/**
 * smoke-check.js — 不依赖游戏运行的逻辑冒烟（对应 issues #1/#8/#10/#11 的回归保护）
 * 运行：node scripts/smoke-check.js（需要先 npm run build 生成 electron-dist/）
 */
const assert = require('assert');
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
      { name: 'org.lwjgl.lwjgl:lwjgl:2.9.2-nightly-20140822', rules: [{ action: 'disallow', os: { name: 'windows' } }], downloads: { artifact: { path: 'y.jar', url: 'https://libraries.minecraft.net/y.jar', sha1: 'def', size: 100 } } },
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

process.exit(fail === 0 ? 0 : 1);
