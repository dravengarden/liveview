// Thin shell: the only window boots a tiny bundled loader page (`../loader`,
// set as `build.frontendDist`) which probes the remote liveview UI and then
// redirects to it. That loader exists to survive the iOS Local Network
// permission prompt (the old direct-to-remote load white-screened until the
// user force-quit); see loader/index.html for the full rationale. Plus the iOS
// native-layer tweaks (background audio + lock-screen controls) that a pure-web
// PWA can't do (see gen/apple/Sources/liveview-app/LiveviewNativeTweaks.mm).
//
// The shell exposes two native capabilities: the opener plugin (the loader's
// "去设置开启" button → iOS app-settings page) and the haptics plugin (the remote
// UI buzzes every control via installHaptics() — iOS Safari/PWA has no reliable
// web haptic, so the native UIImpactFeedbackGenerator is the only path). Both are
// granted to the remote origin in capabilities/ (remote-haptics.json for the
// latter).
//
// `mobile_entry_point` is the symbol the generated iOS/Android projects call;
// on desktop `main.rs` calls `run()` directly.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_haptics::init())
        // B2: cross-platform Rust offline data layer (lv-sync + SqliteBlobStore),
        // exposed to the bundled SPA via the `lvsync://` URI scheme. Registered
        // ALONGSIDE the Swift WKScriptMessageHandler controllers (gen/apple/Sources:
        // LvSyncController + NativeAudioController) during migration: the web still
        // calls the Swift path (native-sync.ts / native-audio.ts), so this is inert
        // at runtime until the web is switched to lvsync:// and verified offline —
        // only then is the Swift content layer retired. Audio stays native (AVPlayer).
        .plugin(tauri_plugin_lvsync::init())
        .run(tauri::generate_context!())
        .expect("error while running liveview native shell");
}
