import { constants, copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export function validateDisplayName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name)) {
    throw new Error('displayName 必须是安全的英文应用名称，不能包含路径、空格或特殊符号。');
  }
  return name;
}

// Keep Tauri's product/registry identity for existing installations. Only rename
// completed distribution files; the signed bytes and internal executable stay intact.
export function renameBundleArtifacts(directory, { productName, displayName, version }) {
  validateDisplayName(displayName);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Invalid bundle version.');
  if (typeof productName !== 'string' || !productName || /[/\\]/.test(productName)) throw new Error('Invalid product name.');
  if (!existsSync(directory)) return [];
  const prefix = `${productName}_${version}_`;
  const plan = [];
  const outputs = [];
  for (const name of readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^(x64|x86|arm64)-setup\.exe$/.test(suffix)
      && !/^(x64|x86|arm64)(_[A-Za-z0-9-]+)?\.msi$/.test(suffix)) continue;
    const destinationName = `${displayName}_${version}_${suffix}`;
    if (name === destinationName) continue;
    for (const extension of ['', '.sig']) {
      const source = join(directory, name + extension);
      if (!existsSync(source)) continue;
      const destination = join(directory, destinationName + extension);
      // Refuse different same-version artifacts rather than replacing a release.
      if (existsSync(destination) && !readFileSync(source).equals(readFileSync(destination))) {
        throw new Error(`${destinationName + extension} 已存在且内容不同；请使用新版本号或先手动归档旧输出。`);
      }
      plan.push({ source, destination });
    }
    outputs.push(destinationName);
  }
  // Preflight the whole set before moving either an installer or its signature.
  for (const { source, destination } of plan) {
    if (!existsSync(destination)) copyFileSync(source, destination, constants.COPYFILE_EXCL);
  }
  for (const { source } of plan) unlinkSync(source);
  return outputs;
}
