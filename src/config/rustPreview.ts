import { version } from '../../package.json';

export const APP_VERSION = version;
export const RUST_PREVIEW_VERSION = APP_VERSION;
/** Every workspace is owned by the embedded Rust application. */
export function usingRustBuiltinBackend(): boolean { return true; }
