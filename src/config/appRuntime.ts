import { version } from '../../package.json';

export const APP_VERSION = version;
/** Every workspace is owned by the embedded Rust application. */
export function usingRustBuiltinBackend(): boolean { return true; }
