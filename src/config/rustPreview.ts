export const RUST_PREVIEW_VERSION = '0.4.0';
/** Every workspace is owned by the embedded Rust application. */
export function usingRustBuiltinBackend(): boolean { return true; }
