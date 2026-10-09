fn main() {
    // Window and executable icons are embedded by the native build.
    // Track regenerated assets even when Rust sources and config are unchanged.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
