import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { renameBundleArtifacts, validateDisplayName } from '../scripts/bundle-names.mjs';

const options = { productName: 'ai-ssh-terminal-client', displayName: 'ShellPilot', version: '0.1.10' };
const oldName = 'ai-ssh-terminal-client_0.1.10_x64-setup.exe';
const newName = 'ShellPilot_0.1.10_x64-setup.exe';
const file = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
function fixture(t) {
  const base = resolve(tmpdir());
  const directory = mkdtempSync(join(base, 'shellpilot-bundle-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), base);
    assert.ok(basename(directory).startsWith('shellpilot-bundle-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('signed installer and signature get the same public name without changing their bytes', t => {
  const directory = fixture(t);
  const installer = Buffer.from([0x4d, 0x5a, 0, 12, 99, 255]);
  writeFileSync(join(directory, oldName), installer);
  writeFileSync(join(directory, `${oldName}.sig`), 'original signature\n');
  const digest = data => createHash('sha256').update(data).digest('hex');
  assert.deepEqual(renameBundleArtifacts(directory, options), [newName]);
  assert.equal(digest(readFileSync(join(directory, newName))), digest(installer));
  assert.equal(readFileSync(join(directory, `${newName}.sig`), 'utf8'), 'original signature\n');
  assert.equal(existsSync(join(directory, oldName)), false);
  assert.equal(existsSync(join(directory, `${oldName}.sig`)), false);
  assert.deepEqual(renameBundleArtifacts(directory, options), []);
});

test('MSI locale and architecture are retained; only this product/version is renamed', t => {
  const directory = fixture(t);
  const names = [
    'ai-ssh-terminal-client_0.1.10_x64_en-US.msi',
    'ai-ssh-terminal-client_0.1.10_arm64_zh-CN.msi',
    'ai-ssh-terminal-client_0.1.10_x86-setup.exe',
  ];
  for (const name of names) writeFileSync(join(directory, name), name);
  const untouched = ['ai-ssh-terminal-client_0.1.9_x64-setup.exe', 'other_0.1.10_x64-setup.exe', 'ai-ssh-terminal-client_0.1.10_x64-setup.exe.log'];
  for (const name of untouched) writeFileSync(join(directory, name), name);
  assert.equal(renameBundleArtifacts(directory, options).length, 3);
  for (const name of names) {
    assert.equal(readFileSync(join(directory, name.replace(options.productName, options.displayName)), 'utf8'), name);
  }
  for (const name of untouched) assert.ok(existsSync(join(directory, name)));
});

test('preflight refuses installer/signature collisions without removing or changing existing outputs', t => {
  for (const extension of ['', '.sig']) {
    const directory = fixture(t);
    writeFileSync(join(directory, oldName), 'new installer');
    writeFileSync(join(directory, `${oldName}.sig`), 'new signature');
    writeFileSync(join(directory, newName + extension), 'existing output');
    assert.throws(() => renameBundleArtifacts(directory, options), /已存在且内容不同/);
    assert.equal(readFileSync(join(directory, newName + extension), 'utf8'), 'existing output');
    assert.equal(readFileSync(join(directory, oldName), 'utf8'), 'new installer');
    assert.equal(readFileSync(join(directory, `${oldName}.sig`), 'utf8'), 'new signature');
    if (extension) assert.equal(existsSync(join(directory, newName)), false);
  }
});

test('identical duplicate is safely consolidated; invalid names/versions fail before mutations', t => {
  const directory = fixture(t);
  for (const name of [oldName, newName]) writeFileSync(join(directory, name), 'same installer');
  assert.deepEqual(renameBundleArtifacts(directory, options), [newName]);
  assert.equal(existsSync(join(directory, oldName)), false);
  assert.equal(readFileSync(join(directory, newName), 'utf8'), 'same installer');
  for (const name of ['../ShellPilot', 'C:\\ShellPilot', 'Shell Pilot', '', null]) {
    assert.throws(() => validateDisplayName(name));
  }
  assert.throws(() => renameBundleArtifacts(directory, { ...options, version: '../0.1.10' }));
  assert.equal(readFileSync(join(directory, newName), 'utf8'), 'same installer');
  assert.deepEqual(renameBundleArtifacts(join(directory, 'missing'), options), []);
});

test('ShellPilot release branding uses the stable identity and consistent product versions', () => {
  const config = JSON.parse(file('src-tauri/tauri.conf.json'));
  const packageInfo = JSON.parse(file('package.json'));
  assert.equal(packageInfo.displayName, 'ShellPilot');
  assert.equal(packageInfo.name, 'ai-ssh-terminal-client');
  assert.equal(config.productName, 'ShellPilot');
  assert.equal(config.identifier, 'com.jasonlat.shellpilot');
  assert.equal(config.mainBinaryName, 'ShellPilot');
  assert.equal(config.version, packageInfo.version);
  assert.match(file('src-tauri/Cargo.toml'), new RegExp(`\\[package\\][\\s\\S]*?version = "${config.version.replaceAll('.', '\\.')}"`));
  assert.match(file('../ai-ssh-terminal-server-rust/Cargo.toml'), new RegExp(`\\[package\\][\\s\\S]*?version = "${config.version.replaceAll('.', '\\.')}"`));
  assert.deepEqual(config.bundle.resources, { 'bundle/backend-info.txt': 'backend-info.txt', 'bundle/backend-LICENSE.txt': 'backend-LICENSE.txt' });
  assert.equal(config.app.windows[0].title, 'ShellPilot');
  for (const path of ['src/components/Shell.tsx', 'src/components/StartupScreen.tsx', 'src/components/ClientUpdateSettings.tsx', 'src/components/StartupUpdatePrompt.tsx', 'index.html']) {
    assert.ok(file(path).includes('ShellPilot'), path);
    assert.ok(!file(path).includes('Agent SSH'), path);
  }
  for (const kind of ['nsis', 'msi', 'windows']) assert.match(packageInfo.scripts[`bundle:${kind}`], /windows-bundle\.mjs/);
  assert.match(file('scripts/windows-bundle.mjs'), /renameBundleArtifacts/);
  assert.match(file('scripts/updater-release.mjs'), /renameBundleArtifacts/);
  assert.match(file('scripts/updater-release.mjs'), /jasonlat-dot\/ai-ssh-terminal-client/);
  assert.match(file('scripts/updater-release.mjs'), /installerName: name/);
  assert.match(file('README.md'), /ShellPilot_<版本>_x64-setup\.exe/);
});
