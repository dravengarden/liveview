// Thin shell: the only window boots a tiny bundled loader page (`../loader`,
// set as `build.frontendDist`) which probes the remote liveview UI and then
// redirects to it. That loader exists to survive the iOS Local Network
// permission prompt (the old direct-to-remote load white-screened until the
// user force-quit); see loader/index.html for the full rationale. Plus the iOS
// native-layer tweaks (background audio + lock-screen controls) that a pure-web
// PWA can't do (see gen/apple/Sources/liveview-app/LiveviewNativeTweaks.mm).
//
// The shell exposes exactly ONE native capability — the opener plugin — so the
// loader's "去设置开启" button can open the iOS app-settings page. The remote
// origin gains no other IPC.
//
// `mobile_entry_point` is the symbol the generated iOS/Android projects call;
// on desktop `main.rs` calls `run()` directly.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running liveview native shell");
}
