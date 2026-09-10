import type { ChatMessage, FileNode, Host, SavedCommand, TerminalEntry } from '../types';

export const hosts: Host[] = [
  { id: 'web', name: 'web-prod-01', user: 'root', address: '10.0.0.12', online: true },
  { id: 'api', name: 'api-prod-02', user: 'root', address: '10.0.0.22', online: false },
];
export const initialCommands: SavedCommand[] = [
  { id: 'disk', name: '磁盘使用', command: 'df -h', category: '系统', icon: 'disk' },
  { id: 'docker', name: '容器状态', command: 'docker compose ps', category: 'Docker', icon: 'box' },
  { id: 'logs', name: '实时日志', command: 'tail -f logs/error.log', category: '日志', icon: 'file' },
  { id: 'ports', name: '查看端口', command: 'ss -tuln', category: '系统', icon: 'network' },
];
export const categories = ['全部', '系统', 'Docker', '日志', '部署'] as const;
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
export const commandOutput = (command: string): string => {
  switch (command.trim()) {
    case 'docker compose ps': return 'NAME        STATUS         PORTS\napp-web     Up 2 hours     0.0.0.0:3000->3000/tcp\napp-redis   Up 2 hours     6379/tcp';
    case 'df -h':
    case 'df -h /': return 'Filesystem   Size   Used   Avail   Use%   Mounted on\n/dev/vda1     80G    28G    52G     35%    /';
    case 'tail -f logs/error.log': return '[模拟日志] 最近 24 小时未发现服务错误。\n[模拟日志] 日志快照结束，未启动持续监听。';
    case 'ss -tuln': return 'Netid  State   Local Address:Port\ntcp    LISTEN  0.0.0.0:22\ntcp    LISTEN  0.0.0.0:3000\ntcp    LISTEN  127.0.0.1:6379';
    default: return '演示模式暂不支持此命令';
  }
};
export const initialEntries: TerminalEntry[] = ['docker compose ps', 'df -h /'].map((command, i) => ({ id: `seed-${i}`, command, output: commandOutput(command) }));
export const initialMessages: ChatMessage[] = [
  { id: 'user-seed', role: 'user', text: '帮我检查服务运行状态和磁盘空间' },
  { id: 'assistant-seed', role: 'assistant', text: '我将检查容器状态与磁盘使用情况。', tools: ['容器状态', '磁盘检查'], summary: '服务运行正常，磁盘使用率 35%，可用空间 52 GB。', suggestion: true },
];
export function mockReply(task: string): ChatMessage {
  return { id: crypto.randomUUID(), role: 'assistant', text: `已收到：${task}`, summary: '当前为演示环境。你可以通过下方操作查看模拟错误日志，或在常用命令中检查容器与磁盘状态。', suggestion: true };
}
export const mockTransferProgress = (progress: number) => Math.min(100, progress + 20);
