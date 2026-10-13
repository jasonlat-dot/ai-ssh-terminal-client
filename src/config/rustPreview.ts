import { activeBackendConnection } from './backend';
export const RUST_PREVIEW_VERSION = '0.4.0';
export function usingRustBuiltinBackend(): boolean { return activeBackendConnection().kind === 'builtin'; }
