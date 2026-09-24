import type { ChatMessage, FileNode, Host, SessionFileState, SavedCommand, SavedCommandIcon } from '../types';

export const hosts: Host[] = [
  { id: 'web', name: 'web-prod-01', user: 'root', address: '10.0.0.12', online: true },
  { id: 'api', name: 'api-prod-02', user: 'root', address: '10.0.0.22', online: false },
];
export const initialCommands: SavedCommand[] = [
  { id: 'disk', name: '磁盘使用', command: 'df -h', category: '系统', icon: 'disk' },
  { id: 'memory', name: '内存使用', command: 'free -h', category: '系统', icon: 'disk' },
  { id: 'uptime', name: '运行时间', command: 'uptime', category: '系统', icon: 'signal' },
  { id: 'kernel', name: '系统信息', command: 'uname -a', category: '系统', icon: 'server' },
  { id: 'docker', name: '容器状态', command: 'docker compose ps', category: 'Docker', icon: 'box' },
  { id: 'docker-running', name: '运行中容器', command: 'docker ps', category: 'Docker', icon: 'box' },
  { id: 'docker-stats', name: '容器资源', command: 'docker stats --no-stream', category: 'Docker', icon: 'box' },
  { id: 'docker-space', name: 'Docker 空间', command: 'docker system df', category: 'Docker', icon: 'disk' },
  { id: 'logs', name: '实时日志', command: 'tail -f logs/error.log', category: '日志', icon: 'file' },
  { id: 'system-errors', name: '系统错误', command: 'journalctl -p err -n 100 --no-pager', category: '日志', icon: 'file' },
  { id: 'kernel-logs', name: '内核日志', command: 'dmesg --level=err,warn | tail -n 100', category: '日志', icon: 'file' },
  { id: 'auth-logs', name: '登录记录', command: 'last -n 20', category: '日志', icon: 'file' },
  { id: 'ports', name: '监听端口', command: 'ss -tulnp', category: '网络', icon: 'network' },
  { id: 'ip-address', name: '网络地址', command: 'ip -brief address', category: '网络', icon: 'network' },
  { id: 'route', name: '路由信息', command: 'ip route', category: '网络', icon: 'network' },
  { id: 'public-ip', name: '公网出口 IP', command: 'curl -s https://api.ipify.org && echo', category: '网络', icon: 'network' },
  { id: 'process-cpu', name: 'CPU 占用', command: 'ps aux --sort=-%cpu | head -n 15', category: '进程', icon: 'signal' },
  { id: 'process-memory', name: '内存占用', command: 'ps aux --sort=-%mem | head -n 15', category: '进程', icon: 'signal' },
  { id: 'process-tree', name: '进程树', command: 'ps -ef --forest', category: '进程', icon: 'signal' },
  { id: 'failed-services', name: '异常服务', command: 'systemctl --failed --no-pager', category: '服务', icon: 'server' },
  { id: 'running-services', name: '运行中服务', command: 'systemctl list-units --type=service --state=running --no-pager', category: '服务', icon: 'server' },
  { id: 'nginx-status', name: 'Nginx 状态', command: 'systemctl status nginx --no-pager', category: '服务', icon: 'server' },
  { id: 'list-files', name: '目录详情', command: 'ls -lah', category: '文件', icon: 'file' },
  { id: 'directory-size', name: '目录大小', command: 'du -sh ./* 2>/dev/null | sort -h', category: '文件', icon: 'disk' },
  { id: 'recent-files', name: '最近文件', command: 'find . -type f -printf "%T@ %p\\n" | sort -nr | head -n 20', category: '文件', icon: 'file' },
  { id: 'git-status', name: 'Git 状态', command: 'git status --short --branch', category: '部署', icon: 'terminal' },
  { id: 'compose-pull', name: '拉取镜像', command: 'docker compose pull', category: '部署', icon: 'box' },
  { id: 'compose-up', name: '更新服务', command: 'docker compose up -d', category: '部署', icon: 'terminal' },
];

export function commandCategoryIcon(category: string): SavedCommandIcon {
  if (category === 'Docker') return 'box';
  if (category === '网络') return 'network';
  if (category === '进程') return 'signal';
  if (category === '服务') return 'server';
  if (category === '系统') return 'disk';
  if (category === '部署') return 'terminal';
  return 'file';
}
export function createFiles(): FileNode[] {
  return [
    { id: 'src', name: 'src', kind: 'folder', children: [{ id: 'src/main.ts', name: 'main.ts', kind: 'file' }] },
    { id: 'public', name: 'public', kind: 'folder', children: [] },
    { id: 'logs', name: 'logs', kind: 'folder', children: [
      { id: 'logs/access.log', name: 'access.log', kind: 'file' },
      { id: 'logs/error.log', name: 'error.log', kind: 'file' },
    ] },
    ...['package.json', 'docker-compose.yml', '.env.example'].map(name => ({ id: name, name, kind: 'file' as const })),
  ];
}
export function flattenFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap(node => [node, ...flattenFiles(node.children ?? [])]);
}
export const initialMessages: ChatMessage[] = [
  { id: 'user-seed', role: 'user', text: '帮我检查服务运行状态和磁盘空间' },
  { id: 'assistant-seed', role: 'assistant', text: '我将检查容器状态与磁盘使用情况。', tools: [{ id: 'docker', name: '容器状态', status: 'success' }, { id: 'disk', name: '磁盘检查', status: 'success' }], summary: '服务运行正常，磁盘使用率 35%，可用空间 52 GB。', suggestion: true },
];
export function mockReply(task: string): ChatMessage {
  return { id: crypto.randomUUID(), role: 'assistant', text: `已收到：${task}`, summary: '当前为演示环境。你可以通过下方操作查看模拟错误日志，或在常用命令中检查容器与磁盘状态。', suggestion: true };
}
export const mockTransferProgress = (progress: number) => Math.min(100, progress + 20);

export function createSessionFileState(): SessionFileState {
  return { open: false, files: createFiles(), selected: 'logs/access.log', expanded: new Set(['logs']), transfers: [] };
}
