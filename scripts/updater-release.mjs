import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_REPOSITORY = 'jasonlat-dot/ai-ssh-terminal-client';
export const UPDATE_ENDPOINT = `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/latest.json`;

function decode(encoded, label) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded.trim())) throw new Error(`${label}必须是 Tauri signer 生成的 Base64 内容。`);
  return Buffer.from(encoded.trim(), 'base64');
}
export function validatePublicKey(encoded) {
  const lines = decode(encoded, '公钥').toString('utf8').trim().split(/\r?\n/);
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment:')) throw new Error('公钥格式不正确；只读取 .key.pub，不能使用私钥。');
  const key = decode(lines[1], '公钥数据');
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed') throw new Error('不是有效的 minisign 公钥。');
  return encoded.trim();
}
export function validateVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('正式发布版本必须为 x.y.z，例如 0.1.5；预发布暂不进入稳定更新通道。');
  }
  return version;
}
export function makeManifest({ version, installerName, signature, notes = '', date = new Date().toISOString() }) {
  validateVersion(version);
  if (typeof installerName !== 'string' || /[/\\]/.test(installerName) || basename(installerName) !== installerName || !installerName.endsWith(`_${version}_x64-setup.exe`)) {
    throw new Error('需要与发布版本一致的 Windows x64 NSIS 安装包，不能混用 MSI 或旧版本文件。');
  }
  const lines = decode(signature, '签名').toString('utf8').trim().split(/\r?\n/);
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment:') || !lines[2].startsWith('trusted comment:')) throw new Error('.sig 文件格式不正确。');
  const data = decode(lines[1], '签名数据');
  if (data.length !== 74 || !['Ed', 'ED'].includes(data.subarray(0, 2).toString()) || decode(lines[3], '全局签名').length !== 64) throw new Error('.sig 数据不完整。');
  if (!Number.isFinite(Date.parse(date))) throw new Error('发布日期无效。');
  return { version, notes, pub_date: new Date(date).toISOString(), platforms: {
    'windows-x86_64': { url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${encodeURIComponent(installerName)}`, signature: signature.trim() },
  } };
}
function json(path) { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')); }
function configAndVersion() {
  const config = json(join(root, 'src-tauri/tauri.conf.json'));
  const version = validateVersion(config.version);
  const packageVersion = json(join(root, 'package.json')).version;
  const cargoVersion = readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8').match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1];
  if (version !== packageVersion || version !== cargoVersion) throw new Error('package.json、Cargo.toml 和 tauri.conf.json 版本不一致，请先统一版本。');
  if (!config.plugins?.updater?.pubkey?.trim()) throw new Error('尚未配置更新公钥。请先生成密钥，再运行 npm run updater:configure -- --public-key <文件.key.pub>。');
  validatePublicKey(config.plugins.updater.pubkey);
  if (JSON.stringify(config.plugins.updater.endpoints) !== JSON.stringify([UPDATE_ENDPOINT])) throw new Error('发布源与脚本不一致，拒绝生成指向错误仓库的更新。');
  if (['dangerousInsecureTransportProtocol', 'dangerousAcceptInvalidCerts', 'dangerousAcceptInvalidHostnames'].some(key => config.plugins.updater[key])) throw new Error('更新发布不能绕过 HTTPS 证书校验。');
  return { config, version };
}
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false });
  if (result.error) throw new Error(`无法执行 ${command}：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} 失败，退出码 ${result.status}`);
}
function notesFile(args) {
  const index = args.indexOf('--notes');
  if (index === -1 || !args[index + 1] || args.length !== 2) throw new Error('必须提供 --notes <更新日志.md>。');
  const notes = readFileSync(resolve(args[index + 1]), 'utf8').trim();
  if (!notes) throw new Error('更新日志不能为空。');
  return notes;
}
function createReleaseFiles(version, notes) {
  const bundle = join(root, 'src-tauri/target/release/bundle/nsis');
  const candidates = readdirSync(bundle).filter(name => name.endsWith('-setup.exe') && name.includes(`_${version}_x64`));
  if (candidates.length !== 1) throw new Error(`未找到唯一的 v${version} x64 NSIS 包，请重新执行签名打包。`);
  const name = candidates[0], installer = join(bundle, name), sig = `${installer}.sig`;
  if (!existsSync(sig)) throw new Error('缺少安装包 .sig；普通 bundle:windows 不能代替签名更新打包。');
  const signature = readFileSync(sig, 'utf8').trim();
  const manifest = makeManifest({ version, installerName: name, signature, notes });
  // Verify bytes against the public key before copying/announcing any release artifact.
  run('cargo', ['run', '--release', '--manifest-path', join(root, 'src-tauri/Cargo.toml'), '--example', 'verify_update', '--',
    join(root, 'src-tauri/tauri.conf.json'), installer, sig]);
  const output = join(root, 'release', `v${version}`);
  if (existsSync(output)) throw new Error(`${output} 已存在；为避免覆盖已签名版本，请使用新的版本号或先手动归档旧输出。`);
  mkdirSync(output, { recursive: true });
  copyFileSync(installer, join(output, name)); copyFileSync(sig, join(output, `${name}.sig`));
  writeFileSync(join(output, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(join(output, 'release-notes.md'), `${notes}\n`, { flag: 'wx' });
  const digest = createHash('sha256').update(readFileSync(installer)).digest('hex');
  writeFileSync(join(output, 'SHA256SUMS'), `${digest}  ${name}\n`, { flag: 'wx' });
  console.log(`发布文件已生成：${output}\n尚未上传 GitHub，也未安装更新。`);
}
export function main(args = process.argv.slice(2)) {
  const [command, ...options] = args;
  if (command === 'configure') {
    if (options.length !== 2 || options[0] !== '--public-key' || !options[1].endsWith('.pub')) throw new Error('用法：npm run updater:configure -- --public-key <myapp.key.pub>');
    const publicKey = validatePublicKey(readFileSync(resolve(options[1]), 'utf8'));
    const path = join(root, 'src-tauri/tauri.conf.json'), config = json(path);
    if (config.plugins?.updater?.pubkey && config.plugins.updater.pubkey !== publicKey) throw new Error('已有不同公钥，拒绝自动换钥；换钥可能导致已安装客户端无法继续更新。');
    config.plugins ??= {}; config.plugins.updater = { ...config.plugins.updater, pubkey: publicKey,
      endpoints: [UPDATE_ENDPOINT], windows: { installMode: 'passive' } };
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    console.log('更新公钥已配置；私钥未读取、未复制。请提交公钥配置，妥善备份私钥。');
    return;
  }
  if (!['build', 'manifest'].includes(command)) throw new Error('子命令：configure、build、manifest。详见 docs/client-updates.md。');
  const notes = notesFile(options), { version } = configAndVersion();
  if (existsSync(join(root, 'release', `v${version}`))) throw new Error(`release/v${version} 已存在，拒绝覆盖。`);
  if (command === 'build') {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前发布脚本要求 Windows x64 构建环境。');
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error('未设置 TAURI_SIGNING_PRIVATE_KEY。私钥只通过环境变量读取，不能提交到仓库。');
    run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
    // Use the supported host target so output stays in target/release/bundle/nsis.
    run(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'build', '--bundles', 'nsis',
      '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: true } })]);
  }
  createReleaseFiles(version, notes);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
