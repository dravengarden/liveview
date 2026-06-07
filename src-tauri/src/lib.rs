// Thin shell: build a default Tauri app whose only window loads the remote
// liveview UI (configured as `build.frontendDist` URL in tauri.conf.json). No
// custom commands, no IPC exposed to the remote origin — the native value here
// is purely the WKWebView wrapping the already-https remote UI, plus the iOS
// native-layer tweaks (background audio + lock-screen controls) that a pure-web
// PWA can't do (see gen/apple/Sources/liveview-app/LiveviewNativeTweaks.mm).
//
// `mobile_entry_point` is the symbol the generated iOS/Android projects call;
// on desktop `main.rs` calls `run()` directly.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running liveview native shell");
}
