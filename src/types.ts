export type Host = { status?: 0 | 1 | 2 | 3; userId?: string; id: string; name: string; user: string; address: string; online: boolean; port?: number; environment?: string; auth?: 'password' | 'key'; keyPath?: string; favorite?: boolean; saved?: boolean };
export type FileNode = { id: string; name: string; kind: 'file' | 'folder'; children?: FileNode[] };
export type Category = string;
export type SavedCommand = { id: string; name: string; command: string; category: Category; icon: 'disk' | 'box' | 'file' | 'network' };
export type TerminalSession = { id: string; hostId: string | null; title: string; busy: boolean; fileState: SessionFileState };
export type ChatToolActivity = { id: string; name: string; command?: string; status: 'running' | 'success' | 'error' | 'unknown'; output?: string; sourceAgent?: string };
export type ChatAgentSegment = { id: string; type: 'text'; text: string } | { id: string; type: 'tool'; tool: ChatToolActivity };
export type ChatAgentActivity = { id: string; name: string; task?: string; status: 'running' | 'success' | 'error' | 'unknown'; output?: string; parentToolCallId?: string; tools: ChatToolActivity[]; segments?: ChatAgentSegment[] };
export type ChatMessageSegment = { id: string; type: 'text'; text: string } | { id: string; type: 'tool'; tool: ChatToolActivity } | { id: string; type: 'agent'; agent: ChatAgentActivity };
export type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; segments?: ChatMessageSegment[]; tools?: ChatToolActivity[]; summary?: string; suggestion?: boolean; error?: boolean };
export type TransferItem = { id: string; name: string; progress: number };
export type Navigation = '连接' | '命令';

export type SessionFileState = { open: boolean; files: FileNode[]; selected: string; expanded: Set<string>; transfers: TransferItem[] };
