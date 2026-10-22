export type DirectoryEntry = { name: string; directory: boolean; symlink: boolean; size: number | null };
export type DirectoryListing = { path: string; entries: DirectoryEntry[]; truncated: boolean };
export type TerminalDirectory = { path: string; revision: number; running?: boolean; access?: 'login' | 'root' | 'unavailable'; accessKey?: string };
export const DIRECTORY_FOLLOW_KEY = 'shellpilot:terminal-directory-follow:v1';
export function readDirectoryFollow() {
  try { return localStorage.getItem(DIRECTORY_FOLLOW_KEY) !== 'false'; } catch { return true; }
}
export function saveDirectoryFollow(value: boolean) {
  try { localStorage.setItem(DIRECTORY_FOLLOW_KEY, String(value)); } catch { /* This window can still follow. */ }
}
export function directoryParent(path: string) { return path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'; }
export function directoryChild(path: string, name: string) { return `${path.replace(/\/+$/, '')}/${name}`; }

/** Read nonce-bound directory reports independently of xterm focus. Never guess cwd from text. */
export class TerminalDirectoryTracker {
  private buffer = '';
  private snapshot: TerminalDirectory = { path: '', revision: 0 };
  private listeners = new Set<() => void>();
  constructor(private nonce?: string) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  adopt(nonce: string) {
    if (!/^[a-f0-9]{32}$/.test(nonce)) return;
    this.nonce = nonce; this.buffer = '';
    if (this.snapshot.access === 'root' || this.snapshot.access === 'unavailable') {
      this.snapshot = { ...this.snapshot, access: 'unavailable', accessKey: `pending;${nonce}`, revision: this.snapshot.revision + 1 };
      this.listeners.forEach(listener => listener());
    }
  }
  feed(data: string) {
    if (!this.nonce) return;
    this.buffer += data;
    while (true) {
      const start = this.buffer.indexOf('\x1b]777;');
      if (start < 0) { this.buffer = this.buffer.slice(-6); return; }
      this.buffer = this.buffer.slice(start);
      const end = /\x07|\x1b\\/.exec(this.buffer);
      if (!end) { if (this.buffer.length > 8300) this.buffer = ''; return; }
      const report = this.buffer.slice(6, end.index);
      this.buffer = this.buffer.slice(end.index + end[0].length);
      if (report === `spc;${this.nonce};B`) {
        this.snapshot = { ...this.snapshot, running: true };
        this.listeners.forEach(listener => listener());
        continue;
      }
      const accessPrefix = `spc;${this.nonce};F;`;
      if (report.startsWith(accessPrefix)) {
        const [uid, loginUid, bridge, extra] = report.slice(accessPrefix.length).split(';');
        if (extra !== undefined || !/^\d{1,10}$/.test(uid) || !/^\d{1,10}$/.test(loginUid) || bridge === undefined) continue;
        const elevated = uid === '0' && loginUid !== '0';
        const validBridge = bridge.startsWith(`/tmp/shellpilot-files.${this.nonce}.`) && /^[a-zA-Z0-9]{10}$/.test(bridge.slice(-10)) && bridge.length === 65;
        const access = elevated ? validBridge ? 'root' : 'unavailable' : 'login';
        const accessKey = `${uid};${loginUid};${validBridge ? bridge : ''}`;
        if (this.snapshot.accessKey !== accessKey) {
          this.snapshot = { ...this.snapshot, access, accessKey, revision: this.snapshot.revision + 1 };
          this.listeners.forEach(listener => listener());
        }
        continue;
      }
      const prefix = `spc;${this.nonce};D;`;
      if (!report.startsWith(prefix)) continue;
      const hex = report.slice(prefix.length);
      if (!hex || hex.length > 8192 || hex.length % 2 || !/^[a-f0-9]+$/i.test(hex)) continue;
      try {
        const path = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(hex.match(/../g)!, value => parseInt(value, 16)));
        if (!path.startsWith('/') || /[\x00-\x1f\x7f-\x9f]/u.test(path)) continue;
        this.snapshot = { ...this.snapshot, path, revision: this.snapshot.revision + 1, running: false };
        this.listeners.forEach(listener => listener());
      } catch { /* Invalid UTF-8 cannot become a directory request. */ }
    }
  }
}
