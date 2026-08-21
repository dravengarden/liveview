// Native shell: the window boots the bundled SPA from `lvsync://localhost`.
// Reader content lives in the TypeScript IDB replica. Native adds the overlay
// host, background audio, lock-screen controls, haptics, and app-settings
// integration that a PWA cannot.
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

mod host;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_haptics::init())
        // Thin `lvsync://localhost` host: overlay + origins + host-info. Content
        // replica is TypeScript IndexedDB; audio decode cache stays in Swift.
        .setup(|app| {
            host::setup(app.handle());
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("lvsync", |ctx, request, responder| {
            host::handle(ctx.app_handle().clone(), request, responder);
        })
        .run(tauri::generate_context!())
        .expect("error while running liveview native shell");
}
