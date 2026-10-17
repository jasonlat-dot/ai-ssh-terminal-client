export const maxSkillDirectories = 16;

export function parseSkillDirectories(rows: string[]): string[] {
  const paths = rows.map(value => value.trim());
  if (paths.filter(Boolean).length > maxSkillDirectories) throw new Error('最多配置 16 个 Skills 目录。');
  paths.forEach((path, index) => {
    if (!path) return;
    const absolute = /^[a-z]:[\\/]/i.test(path) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(path);
    if (!absolute || /[\0\r\n]/.test(path)) throw new Error(`第 ${index + 1} 个目录须为本机绝对路径，例如 C:\\Users\\你的用户名\\.agents\\skills。`);
    if (new TextEncoder().encode(path).length > 4096) throw new Error(`第 ${index + 1} 个目录路径过长，不能超过 4096 字节。`);
  });
  return paths.filter(Boolean);
}
