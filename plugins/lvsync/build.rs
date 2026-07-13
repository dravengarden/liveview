// Generate the plugin's ACL permissions (one allow-/deny- per command) so a
// capability can grant them to the remote origin. The command names here become
// `lvsync:allow-<kebab-name>` (e.g. resolve → lvsync:allow-resolve,
// offline_fraction → lvsync:allow-offline-fraction).
const COMMANDS: &[&str] = &[
    "resolve",
    "knows",
    "status",
    "refresh",
    "offline_fraction",
    "sync_book",
    "sync_all",
    "cache_stats",
    "gc",
];

fn main() {
    // The deployment origin list is embedded by option_env! in the plugin.
    // Without this directive Cargo can reuse an artifact compiled for the
    // simulator's loopback endpoint when producing a physical-device build.
    println!("cargo:rerun-if-env-changed=LIVEVIEW_REMOTE_ORIGINS");
    tauri_plugin::Builder::new(COMMANDS).build();
}
