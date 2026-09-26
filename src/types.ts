export type Host = { userId?: string; id: string; name: string; user: string; address: string; port?: number; environment?: string; auth?: 'password' | 'key'; keyPath?: string; favorite?: boolean; saved?: boolean };
export type FileNode = { id: string; name: string; kind: 'file' | 'folder'; children?: FileNode[] };
export type Category = string;
export type SavedCommandIcon = 'disk' | 'box' | 'file' | 'network' | 'terminal' | 'signal' | 'server';
export type SavedCommand = { id: string; name: string; command: string; category: Category; icon: SavedCommandIcon };
export type TerminalDisconnectReason =
  | 'IDLE_TIMEOUT'
  | 'CLIENT_CLOSED'
  | 'CHANNEL_DISCONNECTED'
  | 'READER_ERROR'
  | 'SESSION_NOT_FOUND';
export type TerminalConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';
export type TerminalSession = {
  id: string;
  connectionId: string;
  terminalSessionId: string;
  connected: boolean;
  connectionStatus: TerminalConnectionStatus;
  disconnectReason: TerminalDisconnectReason | null;
  reconnectAllowed: boolean;
  reconnectAttempts: number;
  reconnecting: boolean;
  readLoopGeneration: number;
  manuallyClosed: boolean;
  host: Host;
  title: string;
  busy: boolean;
  fileState: SessionFileState;
};
export type ChatToolActivity = { id: string; name: string; command?: string; status: 'running' | 'success' | 'error' | 'unknown'; output?: string; sourceAgent?: string };
export type ChatAgentSegment = { id: string; type: 'text'; text: string } | { id: string; type: 'tool'; tool: ChatToolActivity };
export type ChatAgentActivity = { id: string; name: string; task?: string; status: 'running' | 'success' | 'error' | 'unknown'; output?: string; parentToolCallId?: string; tools: ChatToolActivity[]; segments?: ChatAgentSegment[] };
export type ChatMessageSegment = { id: string; type: 'text'; text: string } | { id: string; type: 'tool'; tool: ChatToolActivity } | { id: string; type: 'agent'; agent: ChatAgentActivity };
export type ChatAttachment = { fileId: string; fileName: string; contentType: string; size: number; downloadUrl?: string; urlExpiresAt?: string | number; previewUrl?: string };
export type ChatMessage = { attachments?: ChatAttachment[]; errorCode?: string; id: string; role: 'user' | 'assistant'; text: string; segments?: ChatMessageSegment[]; tools?: ChatToolActivity[]; summary?: string; suggestion?: boolean; error?: boolean };
export type Navigation = '连接' | '命令';

export type SessionFileState = { open: boolean; files: FileNode[]; selected: string; expanded: Set<string> };
