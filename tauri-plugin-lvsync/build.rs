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
    "gc",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
