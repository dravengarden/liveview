// Native shell: the window boots the bundled SPA and resolves reader content
// through the `lvsync://` custom scheme. A configured remote server supplies
// content; native code adds offline storage, background audio,
// lock-screen controls, haptics, and app-settings integration that a PWA cannot.
//
// Document origin is frozen as `lvsync://localhost` (IndexedDB/localStorage
// persistence). Do not rename it.
//
// The shell also exposes the opener plugin (the error UI's "去设置开启" button →
// iOS app-settings page) and the haptics plugin (the bundled UI buzzes controls
// via installHaptics() — iOS Safari/PWA has no reliable
// web haptic, so the native UIImpactFeedbackGenerator is the only path). Both are
// granted in capabilities/.
//
// `mobile_entry_point` is the symbol the generated iOS/Android projects call;
// on desktop `main.rs` calls `run()` directly.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_haptics::init())
        // Cross-platform Rust offline content layer (lv-sync + SqliteBlobStore),
        // exposed to the bundled SPA via the `lvsync://` URI scheme. Audio stays
        // native (AVPlayer).
        .plugin(tauri_plugin_lvsync::init())
        .run(tauri::generate_context!())
        .expect("error while running liveview native shell");
}
