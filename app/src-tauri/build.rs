fn main() {
    // The deployment origin list is embedded by option_env! in the host.
    // Without this directive Cargo can reuse an artifact compiled for the
    // simulator's loopback endpoint when producing a physical-device build.
    println!("cargo:rerun-if-env-changed=LIVEVIEW_REMOTE_ORIGINS");
    tauri_build::build()
}
