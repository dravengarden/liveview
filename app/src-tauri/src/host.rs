//! Thin `lvsync://localhost` host: app-shell overlay and baked remote origins.
//!
//! Document origin is frozen as `lvsync://localhost` (IndexedDB / localStorage).
//! Native fetches overlay bytes from baked `LIVEVIEW_REMOTE_ORIGINS` only — JS
//! never supplies a URL or file bytes. Content replica / APM / DAG live in TS.

use std::borrow::Cow;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, Runtime};

/// Comma-separated backend origins baked into the native shell. Deployments can
/// provide public + LAN routes with `LIVEVIEW_REMOTE_ORIGINS`; a public checkout
/// defaults to the local development server and contains no private endpoints.
const DEFAULT_REMOTE_ORIGINS: &str = "http://127.0.0.1:4160";

/// Frozen host protocol. Additive fields are allowed; renaming a command is a
/// native binary bump.
pub const HOST_PROTOCOL: u32 = 1;

fn remote_origins() -> Vec<&'static str> {
    option_env!("LIVEVIEW_REMOTE_ORIGINS")
        .unwrap_or(DEFAULT_REMOTE_ORIGINS)
        .split(',')
        .map(str::trim)
        .filter(|origin| !origin.is_empty())
        .collect()
}

/// Retired native store leftovers. Audio `lv-audio/*.caf` files stay; they are
/// the live media cache, not the old SQLite replica.
fn purge_retired_store_files(data_dir: &Path) {
    const STORE_FILES: &[&str] = &[
        "lvsync.sqlite",
        "lvsync.sqlite-wal",
        "lvsync.sqlite-shm",
        "dag.json",
        "lv-index-audio.sqlite",
        "lv-index-audio.sqlite-wal",
        "lv-index-audio.sqlite-shm",
    ];
    const AUDIO_SIDECARS: &[&str] = &[
        "_legacy-index.json",
        "_legacy-imported",
        "_pins.json",
        "lv-index-audio.sqlite",
        "lv-index-audio.sqlite-wal",
        "lv-index-audio.sqlite-shm",
    ];
    let mut roots = vec![data_dir.to_path_buf()];
    if let Some(parent) = data_dir.parent() {
        roots.push(parent.to_path_buf());
    }
    for root in &roots {
        for name in STORE_FILES {
            let _ = std::fs::remove_file(root.join(name));
        }
        let audio = root.join("lv-audio");
        for name in AUDIO_SIDECARS {
            let _ = std::fs::remove_file(audio.join(name));
        }
    }
}

#[derive(Debug)]
struct FetchFailure {
    message: String,
}

impl std::fmt::Display for FetchFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

fn successful_response(
    result: Result<reqwest::Response, reqwest::Error>,
) -> Result<reqwest::Response, FetchFailure> {
    let response = result.map_err(|error| FetchFailure {
        message: error.to_string(),
    })?;
    response.error_for_status().map_err(|error| FetchFailure {
        message: error.to_string(),
    })
}

/// Race every configured route and return the first successful HTTP response.
/// Fast failures do not hide a slower healthy route.
async fn send_remote<F>(
    client: &reqwest::Client,
    path: &str,
    configure: F,
) -> Result<reqwest::Response, FetchFailure>
where
    F: Fn(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
{
    use futures_util::stream::{FuturesUnordered, StreamExt as _};

    let mut pending = FuturesUnordered::new();
    for origin in remote_origins() {
        let label = origin.to_string();
        let request = configure(client.get(format!("{origin}{path}"))).send();
        pending.push(async move { (label, request.await) });
    }
    let mut errors = Vec::new();
    while let Some((origin, result)) = pending.next().await {
        match successful_response(result) {
            Ok(response) => return Ok(response),
            Err(error) => {
                errors.push(format!("{origin}: {error}"));
            }
        }
    }
    Err(FetchFailure {
        message: if errors.is_empty() {
            "no backend origins configured".into()
        } else {
            errors.join("; ")
        },
    })
}

fn entry_bundle(html: &str) -> Option<&str> {
    let start = html.find("assets/index-")?;
    let end = html[start..].find(".js")?;
    Some(&html[start..start + end + 3])
}

/// An installed shell update must get one chance to boot its embedded SPA. OTA
/// files live in Application Support and survive an update, so without this
/// boundary a stale `web/current` can mask a newer IPA forever when the old
/// bundle's updater is broken.
fn activate_embedded_upgrade(data_dir: &Path, embedded_index: &[u8]) {
    let Some(version) = std::str::from_utf8(embedded_index)
        .ok()
        .and_then(entry_bundle)
    else {
        return;
    };
    let web_root = data_dir.join("web");
    let marker = web_root.join("embedded-current");
    if std::fs::read_to_string(&marker).ok().as_deref() == Some(version) {
        return;
    }
    let _ = std::fs::create_dir_all(&web_root);
    let _ = std::fs::remove_file(web_root.join("current"));
    let _ = std::fs::write(marker, version);
}

/// Sanitize an OTA version string into a single safe path component.
fn ver_dir(version: &str) -> String {
    version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn query_get(query: &str, k: &str) -> Option<String> {
    query.split('&').find_map(|kv| {
        let mut it = kv.splitn(2, '=');
        if it.next() == Some(k) {
            it.next().map(str::to_string)
        } else {
            None
        }
    })
}

fn sniff_content_type(body: &[u8]) -> &'static str {
    match body {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => "image/webp",
        _ if {
            let s = &body[..body.len().min(64)];
            let t = std::str::from_utf8(s).unwrap_or("").trim_start();
            t.starts_with("<svg")
                || (t.starts_with("<?xml") && body.windows(4).take(256).any(|w| w == b"<svg"))
        } =>
        {
            "image/svg+xml"
        }
        _ => "application/octet-stream",
    }
}

/// JS modules MUST be `text/javascript` to import over a custom scheme — there
/// is no browser MIME-sniff fallback there.
fn content_type_for(path: &str, body: &[u8]) -> &'static str {
    if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript"
    } else if path.ends_with(".css") {
        "text/css"
    } else if path.ends_with(".html") {
        "text/html"
    } else if path.ends_with(".json") || path.ends_with(".webmanifest") {
        "application/json"
    } else if path.ends_with(".wasm") {
        "application/wasm"
    } else if path.ends_with(".woff2") {
        "font/woff2"
    } else if path.ends_with(".woff") {
        "font/woff"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else {
        sniff_content_type(body)
    }
}

fn reject_dotdot(p: &str) -> bool {
    p.contains("..")
}

/// Path-only put: never a `u=` URL. Hashed assets land in `web/files/`; the
/// unhashed entry is always written under `web/roots/<ver>/`.
enum PutPlan {
    Hashed { rel: String },
    Index { ver: String },
}

fn overlay_put_plan(p: &str, v: Option<&str>) -> Result<PutPlan, &'static str> {
    if p.is_empty() {
        return Err("missing p");
    }
    if reject_dotdot(p) {
        return Err("..");
    }
    if p == "index.html" {
        let Some(ver) = v.filter(|s| !s.is_empty()) else {
            return Err("missing v");
        };
        if reject_dotdot(ver) {
            return Err("..");
        }
        return Ok(PutPlan::Index {
            ver: ver.to_string(),
        });
    }
    Ok(PutPlan::Hashed {
        rel: p.trim_start_matches('/').to_string(),
    })
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("write: {e}"))
}

fn http_client(connect_ms: u64, timeout_s: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(connect_ms))
        .timeout(Duration::from_secs(timeout_s))
        .build()
        .unwrap_or_default()
}

async fn dl(client: &reqwest::Client, path: &str) -> Result<Vec<u8>, String> {
    match send_remote(client, &format!("/app-dist/{path}"), |request| request).await {
        Ok(r) => r
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| format!("dl-body {path}: {e}")),
        Err(e) => Err(format!("dl {path}: {e}")),
    }
}

pub struct HostState {
    web_root: PathBuf,
    native_version: String,
}

impl HostState {
    fn new(data_dir: PathBuf, native_version: String) -> Self {
        purge_retired_store_files(&data_dir);
        let web_root = data_dir.join("web");
        Self {
            web_root,
            native_version,
        }
    }

    /// Overlay file for the CURRENT version, or None → embedded frontendDist.
    /// Debug shells always return None so a stale `web/current` cannot mask the
    /// just-built bundle (the load-bearing overlay disable).
    fn web_get(&self, rel: &str) -> Option<Vec<u8>> {
        if cfg!(debug_assertions) {
            return None;
        }
        overlay_read(&self.web_root, rel)
    }

    fn current_version(&self) -> String {
        std::fs::read_to_string(self.web_root.join("current"))
            .unwrap_or_default()
            .trim()
            .to_string()
    }

    fn hashed_exists(&self, p: &str) -> bool {
        if p.is_empty() || p == "index.html" || reject_dotdot(p) {
            return false;
        }
        self.web_root
            .join("files")
            .join(p.trim_start_matches('/'))
            .is_file()
    }

    async fn put_from_url(&self, p: &str, v: Option<&str>) -> Result<&'static str, String> {
        let plan = overlay_put_plan(p, v).map_err(str::to_string)?;
        let client = http_client(8_000, 120);
        match plan {
            PutPlan::Hashed { rel } => {
                let dest = self.web_root.join("files").join(&rel);
                if dest.is_file() {
                    return Ok("skipped");
                }
                let bytes = dl(&client, &rel).await?;
                write_file(&dest, &bytes)?;
                Ok("ok")
            }
            PutPlan::Index { ver } => {
                let dest = self
                    .web_root
                    .join("roots")
                    .join(ver_dir(&ver))
                    .join("index.html");
                let bytes = dl(&client, "index.html").await?;
                write_file(&dest, &bytes)?;
                Ok("ok")
            }
        }
    }

    fn activate(&self, version: &str, assets: &[String]) -> Result<(), String> {
        if version.is_empty() || reject_dotdot(version) {
            return Err("bad version".into());
        }
        let root_dir = self.web_root.join("roots").join(ver_dir(version));
        if !root_dir.join("index.html").is_file() {
            return Err("no-index".into());
        }
        for asset in assets {
            if reject_dotdot(asset) || asset.is_empty() || asset == "index.html" {
                return Err(format!("bad asset {asset}"));
            }
            let dest = self
                .web_root
                .join("files")
                .join(asset.trim_start_matches('/'));
            if !dest.is_file() {
                return Err(format!("missing {asset}"));
            }
        }
        let root_json = serde_json::json!({ "version": version, "assets": assets });
        write_file(
            &root_dir.join("manifest.json"),
            root_json.to_string().as_bytes(),
        )?;
        // Flip `current` last so a partial download never goes live.
        write_file(self.web_root.join("current").as_path(), version.as_bytes())?;
        self.web_record_version(version);
        // Empty assets would contribute no keep-entries, so file GC would
        // prune hashed files unique to this version. Skip that prune.
        self.web_gc(!assets.is_empty());
        Ok(())
    }

    fn web_record_version(&self, version: &str) {
        let p = self.web_root.join("versions");
        let mut vs: Vec<String> = std::fs::read_to_string(&p)
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.is_empty() && *l != version)
            .map(str::to_string)
            .collect();
        vs.push(version.to_string());
        let _ = std::fs::write(&p, vs.join("\n"));
    }

    fn web_gc(&self, prune_unlisted_files: bool) {
        let vs: Vec<String> = std::fs::read_to_string(self.web_root.join("versions"))
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect();
        let keep: HashSet<&String> = vs.iter().rev().take(3).collect();
        let roots = self.web_root.join("roots");
        let mut keep_assets: HashSet<String> = HashSet::new();
        if let Ok(entries) = std::fs::read_dir(&roots) {
            for e in entries.flatten() {
                let vdir = e.file_name().to_string_lossy().to_string();
                let kept = keep.iter().any(|v| ver_dir(v) == vdir);
                if !kept {
                    let _ = std::fs::remove_dir_all(e.path());
                    continue;
                }
                if let Ok(t) = std::fs::read_to_string(e.path().join("manifest.json"))
                    && let Ok(v) = serde_json::from_str::<serde_json::Value>(&t)
                    && let Some(arr) = v.get("assets").and_then(|a| a.as_array())
                {
                    for a in arr {
                        if let Some(s) = a.as_str() {
                            keep_assets.insert(s.to_string());
                        }
                    }
                }
            }
        }
        if prune_unlisted_files {
            let files = self.web_root.join("files");
            prune_files(&files, &files, &keep_assets);
        }
        let trimmed: Vec<String> = vs.iter().filter(|v| keep.contains(v)).cloned().collect();
        let _ = std::fs::write(self.web_root.join("versions"), trimmed.join("\n"));
    }

    fn host_info_json(&self) -> Vec<u8> {
        serde_json::json!({
            "protocol": HOST_PROTOCOL,
            "nativeVersion": self.native_version,
            "debugEmbedded": cfg!(debug_assertions),
        })
        .to_string()
        .into_bytes()
    }
}

fn overlay_read(web_root: &Path, rel: &str) -> Option<Vec<u8>> {
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() || reject_dotdot(rel) {
        return None;
    }
    let current = std::fs::read_to_string(web_root.join("current")).ok()?;
    let current = current.trim();
    if current.is_empty() {
        return None;
    }
    if rel == "index.html" {
        return std::fs::read(
            web_root
                .join("roots")
                .join(ver_dir(current))
                .join("index.html"),
        )
        .ok();
    }
    std::fs::read(web_root.join("files").join(rel)).ok()
}

fn prune_files(base: &Path, dir: &Path, keep: &HashSet<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            prune_files(base, &p, keep);
        } else if let Ok(rel) = p.strip_prefix(base)
            && !keep.contains(&rel.to_string_lossy().to_string())
        {
            let _ = std::fs::remove_file(&p);
        }
    }
}

fn respond(
    status: u16,
    content_type: &str,
    cache: Option<&str>,
    body: Vec<u8>,
) -> Response<Cow<'static, [u8]>> {
    let mut builder = Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Type", content_type);
    if let Some(cache) = cache {
        builder = builder.header("Cache-Control", cache);
    }
    builder
        .body(Cow::<[u8]>::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new())))
}

fn app_rel(path: &str) -> Option<&str> {
    match path {
        "/" | "/index.html" | "/app" | "/app/" => Some("index.html"),
        _ => path.strip_prefix("/app/"),
    }
}

async fn scheme_dispatch(
    state: &HostState,
    method: &str,
    path: &str,
    query: &str,
    body: &[u8],
) -> (u16, Vec<u8>) {
    let post = method.eq_ignore_ascii_case("POST");
    match path {
        "/origins" => match serde_json::to_vec(&remote_origins()) {
            Ok(body) => (200, body),
            Err(error) => (500, error.to_string().into_bytes()),
        },
        "/host-info" => (200, state.host_info_json()),
        "/appshell/current" => (200, state.current_version().into_bytes()),
        "/appshell/has" => {
            let Some(p) = query_get(query, "p") else {
                return (400, b"missing p".to_vec());
            };
            let flag = if state.hashed_exists(&p) { "1" } else { "0" };
            (200, flag.as_bytes().to_vec())
        }
        "/appshell/putFromUrl" => {
            if !post {
                return (405, b"POST only".to_vec());
            }
            // Path-only: `u=` is ignored even if a caller smuggles it.
            let Some(p) = query_get(query, "p") else {
                return (400, b"missing p".to_vec());
            };
            let v = query_get(query, "v");
            match state.put_from_url(&p, v.as_deref()).await {
                Ok(msg) => (200, msg.as_bytes().to_vec()),
                Err(e) => (400, e.into_bytes()),
            }
        }
        "/appshell/activate" => {
            if !post {
                return (405, b"POST only".to_vec());
            }
            let Some(v) = query_get(query, "v") else {
                return (400, b"missing v".to_vec());
            };
            let assets: Vec<String> = if body.is_empty() {
                Vec::new()
            } else {
                match serde_json::from_slice::<serde_json::Value>(body) {
                    Ok(json) => json
                        .get("assets")
                        .and_then(|a| a.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|x| x.as_str().map(str::to_string))
                                .collect()
                        })
                        .unwrap_or_default(),
                    Err(_) => return (400, b"bad json".to_vec()),
                }
            };
            match state.activate(&v, &assets) {
                Ok(()) => (200, b"ok".to_vec()),
                Err(e) => (409, e.into_bytes()),
            }
        }
        _ => (404, b"not found".to_vec()),
    }
}

pub fn setup<R: Runtime>(app: &AppHandle<R>) {
    let data_dir = match app.path().app_data_dir() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("lvsync host init failed: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("lvsync host mkdir failed: {e}");
        return;
    }
    if let Some(index) = app.asset_resolver().get("index.html".to_string()) {
        activate_embedded_upgrade(&data_dir, &index.bytes);
    }
    let native_version = app.package_info().version.to_string();
    app.manage(HostState::new(data_dir, native_version));
}

pub fn handle<R: Runtime>(
    app: AppHandle<R>,
    request: Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or("").to_string();
    let body = request.into_body();
    tauri::async_runtime::spawn(async move {
        if let Some(rel0) = app_rel(&path) {
            let rel = if rel0.is_empty() { "index.html" } else { rel0 };
            let overlay = app.try_state::<HostState>().and_then(|s| s.web_get(rel));
            let body =
                overlay.or_else(|| app.asset_resolver().get(rel.to_string()).map(|a| a.bytes));
            let (status, bytes) = match body {
                Some(b) => (200u16, b),
                None => (404u16, b"not found".to_vec()),
            };
            let cache = if rel == "index.html" {
                "no-store"
            } else {
                "public, max-age=31536000, immutable"
            };
            responder.respond(respond(
                status,
                content_type_for(rel, &bytes),
                Some(cache),
                bytes,
            ));
            return;
        }
        let (status, body) = match app.try_state::<HostState>() {
            Some(state) => scheme_dispatch(&state, &method, &path, &query, &body).await,
            None => (503, b"host not ready".to_vec()),
        };
        responder.respond(respond(status, content_type_for(&path, &body), None, body));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now_ms() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    }

    fn temp_state(suffix: &str) -> (PathBuf, HostState) {
        let root = std::env::temp_dir().join(format!(
            "liveview-host-test-{suffix}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let data = root.join("plugin");
        std::fs::create_dir_all(&data).unwrap();
        (root, HostState::new(data, "0.1.0-test".into()))
    }

    #[test]
    fn host_boot_deletes_retired_store_files_and_keeps_audio() {
        let root = std::env::temp_dir().join(format!(
            "liveview-host-purge-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let data = root.join("plugin");
        let audio = root.join("lv-audio");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&audio).unwrap();
        std::fs::write(data.join("lvsync.sqlite"), b"old").unwrap();
        std::fs::write(data.join("dag.json"), b"{}").unwrap();
        std::fs::write(audio.join("_legacy-index.json"), b"{}").unwrap();
        std::fs::write(audio.join("_pins.json"), b"[]").unwrap();
        std::fs::write(audio.join("abc.caf"), b"caf").unwrap();
        let _state = HostState::new(data.clone(), "0.1.0-test".into());
        assert!(!data.join("lvsync.sqlite").exists());
        assert!(!data.join("dag.json").exists());
        assert!(!audio.join("_legacy-index.json").exists());
        assert!(!audio.join("_pins.json").exists());
        assert!(audio.join("abc.caf").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn content_types_and_ver_dir_are_stable() {
        assert_eq!(content_type_for("assets/app.js", b""), "text/javascript");
        assert_eq!(content_type_for("assets/app.mjs", b""), "text/javascript");
        assert_eq!(content_type_for("assets/font.woff2", b""), "font/woff2");
        assert_eq!(ver_dir("assets/index-a.b/c"), "assets_index_a_b_c");
    }

    #[test]
    fn put_from_url_is_path_only_and_ignores_u() {
        let query = "p=assets/index-abc.js&u=https://evil.example/x.js";
        let p = query_get(query, "p").unwrap();
        assert_eq!(p, "assets/index-abc.js");
        let plan = overlay_put_plan(&p, query_get(query, "v").as_deref()).unwrap();
        match plan {
            PutPlan::Hashed { rel } => {
                assert_eq!(rel, "assets/index-abc.js");
                assert!(!rel.contains("evil"));
            }
            PutPlan::Index { .. } => panic!("hashed path must not use roots/"),
        }
        assert!(query_get(query, "u").is_some(), "fixture still carries u=");
    }

    #[test]
    fn index_html_with_version_uses_roots_layout() {
        let plan = overlay_put_plan("index.html", Some("assets/index-new.js")).unwrap();
        match plan {
            PutPlan::Index { ver } => {
                assert_eq!(ver_dir(&ver), "assets_index_new_js");
            }
            PutPlan::Hashed { .. } => panic!("index.html must not skip via files/"),
        }
        assert!(overlay_put_plan("index.html", None).is_err());
        assert!(overlay_put_plan("index.html", Some("")).is_err());
    }

    #[test]
    fn put_plan_rejects_dotdot() {
        assert!(overlay_put_plan("../secret.js", None).is_err());
        assert!(overlay_put_plan("assets/../x.js", None).is_err());
        assert!(overlay_put_plan("index.html", Some("../v")).is_err());
    }

    #[test]
    fn overlay_read_rejects_dotdot_and_debug_web_get_is_none() {
        let (root, state) = temp_state("webget");
        let ver = ver_dir("v1");
        let roots = state.web_root.join("roots").join(&ver);
        std::fs::create_dir_all(&roots).unwrap();
        std::fs::create_dir_all(state.web_root.join("files").join("assets")).unwrap();
        std::fs::write(roots.join("index.html"), b"<html>ota</html>").unwrap();
        std::fs::write(
            state.web_root.join("files").join("assets").join("x.js"),
            b"1",
        )
        .unwrap();
        std::fs::write(state.web_root.join("current"), "v1").unwrap();

        assert!(overlay_read(&state.web_root, "index.html").is_some());
        assert!(overlay_read(&state.web_root, "../current").is_none());
        assert!(overlay_read(&state.web_root, "files/../../current").is_none());
        // cargo test is debug: the load-bearing overlay disable must win even
        // when a stale web/current exists.
        assert!(state.web_get("index.html").is_none());
        assert!(state.web_get("assets/x.js").is_none());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hashed_put_skips_when_dest_exists_index_always_writes() {
        let (root, state) = temp_state("putlayout");
        let hashed = state.web_root.join("files").join("assets/index-abc.js");
        write_file(&hashed, b"old").unwrap();
        match overlay_put_plan("assets/index-abc.js", None).unwrap() {
            PutPlan::Hashed { rel } => {
                let dest = state.web_root.join("files").join(rel);
                assert!(dest.is_file());
            }
            PutPlan::Index { .. } => panic!(),
        }
        match overlay_put_plan("index.html", Some("v2")).unwrap() {
            PutPlan::Index { ver } => {
                let dest = state
                    .web_root
                    .join("roots")
                    .join(ver_dir(&ver))
                    .join("index.html");
                assert!(!dest.is_file(), "index.html is never skipped via has");
            }
            PutPlan::Hashed { .. } => panic!(),
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn activate_refuses_incomplete_set_then_flips_current_last() {
        let (root, state) = temp_state("activate");
        let ver = "assets/index-new.js";
        let root_dir = state.web_root.join("roots").join(ver_dir(ver));
        std::fs::create_dir_all(&root_dir).unwrap();
        let assets = vec!["assets/chunk.js".to_string()];
        assert!(
            state
                .activate(ver, &assets)
                .unwrap_err()
                .contains("no-index"),
            "missing index.html must refuse"
        );
        assert!(!state.web_root.join("current").is_file());

        write_file(&root_dir.join("index.html"), b"<html/>").unwrap();
        assert!(
            state
                .activate(ver, &assets)
                .unwrap_err()
                .contains("missing"),
            "missing hashed asset must refuse"
        );
        assert!(!state.web_root.join("current").is_file());

        write_file(&state.web_root.join("files").join("assets/chunk.js"), b"js").unwrap();
        state.activate(ver, &assets).unwrap();
        assert_eq!(state.current_version(), ver);
        assert!(root_dir.join("manifest.json").is_file());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn activate_empty_assets_does_not_prune_just_fetched_files() {
        let (root, state) = temp_state("activate-empty");
        let ver = "v-empty";
        let root_dir = state.web_root.join("roots").join(ver_dir(ver));
        write_file(&root_dir.join("index.html"), b"<html/>").unwrap();
        let hashed = state.web_root.join("files").join("assets/chunk.js");
        write_file(&hashed, b"js").unwrap();
        state.activate(ver, &[]).unwrap();
        assert_eq!(state.current_version(), ver);
        assert!(
            hashed.is_file(),
            "empty assets must not GC just-fetched hashed files"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn hashed_has_never_reports_index_html() {
        let (root, state) = temp_state("has");
        write_file(
            &state
                .web_root
                .join("roots")
                .join(ver_dir("v"))
                .join("index.html"),
            b"x",
        )
        .unwrap();
        assert!(!state.hashed_exists("index.html"));
        assert!(!state.hashed_exists("../files/x.js"));
        write_file(&state.web_root.join("files").join("a.js"), b"1").unwrap();
        assert!(state.hashed_exists("a.js"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn origins_and_host_info_reject_retired_legacy_routes() {
        let (root, state) = temp_state("routes");
        let (status, body) = scheme_dispatch(&state, "GET", "/origins", "", b"").await;
        assert_eq!(status, 200);
        let origins: Vec<String> = serde_json::from_slice(&body).unwrap();
        assert_eq!(origins, remote_origins());

        let (status, body) = scheme_dispatch(&state, "GET", "/host-info", "", b"").await;
        assert_eq!(status, 200);
        let info: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(info["protocol"], HOST_PROTOCOL);
        assert_eq!(info["nativeVersion"], "0.1.0-test");
        assert_eq!(info["debugEmbedded"], cfg!(debug_assertions));

        let (status, _) = scheme_dispatch(&state, "GET", "/legacy-index", "", b"").await;
        assert_eq!(status, 404);
        let (status, _) = scheme_dispatch(&state, "POST", "/legacy-wipe", "", b"").await;
        assert_eq!(status, 404);

        let (status, _) = scheme_dispatch(&state, "GET", "/resolve", "u=/api/x", b"").await;
        assert_eq!(status, 404);
        let (status, _) = scheme_dispatch(&state, "GET", "/ota-check", "", b"").await;
        assert_eq!(status, 404);

        let (status, body) =
            scheme_dispatch(&state, "POST", "/appshell/putFromUrl", "p=../x.js", b"").await;
        assert_eq!(status, 400);
        assert!(String::from_utf8_lossy(&body).contains(".."));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shell_upgrade_retires_a_stale_ota_overlay_once() {
        let root = std::env::temp_dir().join(format!(
            "liveview-host-embedded-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let web = root.join("web");
        std::fs::create_dir_all(&web).unwrap();
        std::fs::write(web.join("current"), "assets/index-old.js").unwrap();

        let index = br#"<script type="module" src="./assets/index-new.js"></script>"#;
        activate_embedded_upgrade(&root, index);
        assert!(!web.join("current").exists());
        assert_eq!(
            std::fs::read_to_string(web.join("embedded-current")).unwrap(),
            "assets/index-new.js"
        );

        std::fs::write(web.join("current"), "assets/index-server.js").unwrap();
        activate_embedded_upgrade(&root, index);
        assert_eq!(
            std::fs::read_to_string(web.join("current")).unwrap(),
            "assets/index-server.js"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn app_rel_aliases_resolve_to_index() {
        assert_eq!(app_rel("/"), Some("index.html"));
        assert_eq!(app_rel("/index.html"), Some("index.html"));
        assert_eq!(app_rel("/app"), Some("index.html"));
        assert_eq!(app_rel("/app/"), Some("index.html"));
        assert_eq!(app_rel("/app/assets/x.js"), Some("assets/x.js"));
    }
}
