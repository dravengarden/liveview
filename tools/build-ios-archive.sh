#!/usr/bin/env bash
# Build an unsigned iOS release archive (LiveView.xcarchive) from this clean
# Git revision. Build-only: never reads signing credentials, provisioning
# profiles, or App Store Connect API keys.
set -euo pipefail

usage() {
  echo "usage: bash tools/build-ios-archive.sh --version X.Y.Z --build-number N [--origins URLS] [--spa-dir /abs/dist-app] [--receipt-path /absolute/new.json]" >&2
  exit 2
}

lv_version=
lv_build_number=
lv_origins="${LIVEVIEW_REMOTE_ORIGINS:-}"
lv_spa_dir=
lv_report_target=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      lv_version="${2:?--version requires X.Y.Z}"
      shift 2
      ;;
    --build-number)
      lv_build_number="${2:?--build-number requires a CFBundleVersion}"
      shift 2
      ;;
    --origins)
      lv_origins="${2:?--origins requires comma-separated URLs}"
      shift 2
      ;;
    --spa-dir)
      lv_spa_dir="${2:?--spa-dir requires an absolute path}"
      shift 2
      ;;
    --receipt-path)
      lv_report_target="${2:?--receipt-path requires an absolute path}"
      shift 2
      case "$lv_report_target" in /*) ;; *) echo "receipt path must be absolute" >&2; exit 2;; esac
      test ! -e "$lv_report_target" && test ! -L "$lv_report_target" || {
        echo "refusing to overwrite a build receipt" >&2; exit 1;
      }
      ;;
    *)
      usage
      ;;
  esac
done

test -n "$lv_version" && test -n "$lv_build_number" || usage
test -n "$lv_origins" || { echo "Set --origins or LIVEVIEW_REMOTE_ORIGINS" >&2; exit 2; }
test "$(uname -s)" = Darwin || { echo "iOS archive builds require a Mac with Xcode" >&2; exit 1; }
test "$(uname -m)" = arm64 || { echo "This build entry targets an arm64 Mac" >&2; exit 1; }

python3 - "$lv_version" "$lv_build_number" <<'PY'
import re, sys
version, build_number = sys.argv[1:]
if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
    raise SystemExit("invalid --version (expected X.Y.Z): " + version)
if len(build_number) > 18 or not re.fullmatch(r"(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}", build_number):
    raise SystemExit("invalid --build-number for App Store Connect CFBundleVersion: " + build_number)
PY

lv_repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$lv_repo"
test -z "$(git status --porcelain)" || { echo "Release builds require clean, committed source" >&2; exit 1; }
lv_revision="$(git rev-parse HEAD)"

if [ -z "$lv_spa_dir" ]; then
  lv_spa_dir="$lv_repo/web/dist-app"
fi
test -f "$lv_spa_dir/index.html" || { echo "missing built native SPA at $lv_spa_dir/index.html" >&2; exit 1; }

# Verify iOS App Store 1024x1024 icon has no alpha channel (prevents ITMS-90717).
python3 - "$lv_repo/app/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png" <<'PY'
import pathlib, struct, sys
p = pathlib.Path(sys.argv[1])
raw = p.read_bytes()
assert raw[:8] == b"\x89PNG\r\n\x1a\n", "AppIcon-512@2x.png is not PNG"
w, h, bd, ct = struct.unpack(">IIBB", raw[16:26])
if (w, h) != (1024, 1024) or ct != 2:
    raise SystemExit(f"AppIcon-512@2x.png must be 1024x1024 opaque RGB (ct=2), got {w}x{h} ct={ct}")
PY

lv_rust="$(python3 -c 'import re, pathlib; m = re.search(r"channel\s*=\s*\"([^\"]+)\"", pathlib.Path("rust-toolchain.toml").read_text()); print(m.group(1))')"
rustup toolchain list | grep -Fq "$lv_rust-aarch64-apple-darwin" || {
  echo "Install pinned Rust $lv_rust toolchain first" >&2; exit 1;
}
export RUSTUP_TOOLCHAIN="$lv_rust"
test "$(rustc --version | cut -d ' ' -f 2)" = "$lv_rust"
rustup target list --installed | grep -Fxq "aarch64-apple-ios" || {
  echo "Install aarch64-apple-ios target for Rust $lv_rust first" >&2; exit 1;
}
xcodebuild -version

# Never inherit signing credentials into an unsigned archive build.
unset APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_DEVELOPMENT_TEAM
unset APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH
unset APPLE_ID APPLE_PASSWORD APPLE_PROVISIONING_PROFILE APPLE_TEAM_ID
unset TAURI_CONFIG TAURI_ENV_TARGET_TRIPLE TAURI_SIGNING_PRIVATE_KEY
unset CARGO_TARGET_DIR RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER RUSTFLAGS CARGO_ENCODED_RUSTFLAGS
export LANG=en_US.UTF-8
export LIVEVIEW_REMOTE_ORIGINS="$lv_origins"
export LIVEVIEW_WIDGET_SERVER_URL="${lv_origins%%,*}"

mkdir -p target/native-shell
lv_build="$(mktemp -d "$lv_repo/target/native-shell/ios-${lv_revision:0:12}.XXXXXX")"
echo "LiveView iOS build directory: $lv_build"

mkdir -p "$lv_build/app" "$lv_build/web/dist-app"
git archive "$lv_revision:app" | tar -xf - -C "$lv_build/app"
ditto "$lv_spa_dir" "$lv_build/web/dist-app"

export CARGO_TARGET_DIR="$lv_build/target"
cd "$lv_build/app/src-tauri"

python3 - tauri.conf.json gen/apple/project.yml gen/apple/liveview-app_iOS/Info.plist gen/apple/Widgets/Info.plist "$lv_version" "$lv_build_number" <<'PY'
import json, pathlib, plistlib, sys

conf_path, project_path, app_info_path, widget_info_path, version, build_number = sys.argv[1:]

conf_file = pathlib.Path(conf_path)
conf = json.loads(conf_file.read_text())
conf["version"] = version
conf.setdefault("bundle", {}).setdefault("iOS", {})["bundleVersion"] = build_number
conf_file.write_text(json.dumps(conf, indent=2) + "\n")

project = pathlib.Path(project_path)
lines = project.read_text().splitlines(keepends=True)
out = []
ver_count = 0
bld_count = 0
for line in lines:
    if "CFBundleShortVersionString:" in line:
        prefix = line.split("CFBundleShortVersionString:", 1)[0]
        out.append(f"{prefix}CFBundleShortVersionString: {version}\n")
        ver_count += 1
    elif "CFBundleVersion:" in line:
        prefix = line.split("CFBundleVersion:", 1)[0]
        out.append(f'{prefix}CFBundleVersion: "{build_number}"\n')
        bld_count += 1
    else:
        out.append(line)
if ver_count < 2 or bld_count < 2:
    raise SystemExit(f"expected app + widget versions in project.yml, stamped ver={ver_count} bld={bld_count}")
project.write_text("".join(out))

for p in (app_info_path, widget_info_path):
    pf = pathlib.Path(p)
    if pf.exists():
        info = plistlib.loads(pf.read_bytes())
        info["CFBundleShortVersionString"] = version
        info["CFBundleVersion"] = build_number
        pf.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_XML))
PY

mkdir -p gen/apple/Externals gen/apple/assets
(cd gen/apple && xcodegen generate --spec project.yml)
cargo tauri ios build --no-sign --archive-only --target aarch64 --ci -- --locked

src_archive="$lv_build/app/src-tauri/gen/apple/build/liveview-app_iOS.xcarchive"
test -d "$src_archive/Products/Applications/LiveView.app" || {
  echo "Build returned no LiveView.app archive at $src_archive" >&2; exit 1;
}
cmp "$lv_build/app/src-tauri/Cargo.lock" "$lv_repo/app/src-tauri/Cargo.lock"
ditto "$src_archive" "$lv_build/LiveView.xcarchive"

python3 - "$lv_build/LiveView.xcarchive" "$lv_revision" "$lv_build" "$lv_report_target" "$lv_version" "$lv_build_number" "$LIVEVIEW_WIDGET_SERVER_URL" <<'PY'
import hashlib, json, pathlib, plistlib, subprocess, sys

xcarchive_arg, revision, build_arg, receipt_target, expected_version, expected_build, expected_widget_url = sys.argv[1:]
xcarchive = pathlib.Path(xcarchive_arg).resolve(strict=True)
build = pathlib.Path(build_arg).resolve(strict=True)
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()

app = xcarchive / "Products/Applications/LiveView.app"
widget = app / "PlugIns/LiveViewWidgets.appex"
for bundle in (app, widget):
    if not bundle.is_dir():
        raise SystemExit("missing archived bundle: " + str(bundle))
    if (bundle / "_CodeSignature").exists() or (bundle / "embedded.mobileprovision").exists():
        raise SystemExit("unsigned archive unexpectedly carries signing artifacts: " + str(bundle))

app_info = plistlib.loads((app / "Info.plist").read_bytes())
widget_info = plistlib.loads((widget / "Info.plist").read_bytes())

if app_info.get("CFBundleIdentifier") != "top.thundersparrow.liveview":
    raise SystemExit("unexpected app bundle id: " + repr(app_info.get("CFBundleIdentifier")))
if widget_info.get("CFBundleIdentifier") != "top.thundersparrow.liveview.widgets":
    raise SystemExit("unexpected widget bundle id: " + repr(widget_info.get("CFBundleIdentifier")))
for label, info in (("app", app_info), ("widget", widget_info)):
    if info.get("CFBundleShortVersionString") != expected_version:
        raise SystemExit(f"{label} CFBundleShortVersionString {info.get('CFBundleShortVersionString')!r} != {expected_version!r}")
    if info.get("CFBundleVersion") != expected_build:
        raise SystemExit(f"{label} CFBundleVersion {info.get('CFBundleVersion')!r} != {expected_build!r}")

if app_info.get("ITSAppUsesNonExemptEncryption") is not False:
    raise SystemExit("compiled app missing ITSAppUsesNonExemptEncryption=false")
if "audio" not in (app_info.get("UIBackgroundModes") or []):
    raise SystemExit("compiled app missing audio UIBackgroundModes")
if not app_info.get("UIApplicationSceneManifest"):
    raise SystemExit("compiled app missing UIApplicationSceneManifest")
if widget_info.get("LiveViewServerURL") != expected_widget_url:
    raise SystemExit(f"widget LiveViewServerURL {widget_info.get('LiveViewServerURL')!r} != {expected_widget_url!r}")

archive_props = plistlib.loads((xcarchive / "Info.plist").read_bytes()).get("ApplicationProperties", {})
if (
    archive_props.get("CFBundleIdentifier") != "top.thundersparrow.liveview"
    or archive_props.get("CFBundleShortVersionString") != expected_version
    or archive_props.get("CFBundleVersion") != expected_build
):
    raise SystemExit("xcarchive ApplicationProperties mismatch: " + repr(archive_props))

app_bin = app / app_info["CFBundleExecutable"]
widget_bin = widget / widget_info["CFBundleExecutable"]
report = dict(
    source_revision=revision,
    platform="ios",
    profile="release",
    signing="unsigned",
    xcarchive=str(xcarchive),
    bundle_id=app_info["CFBundleIdentifier"],
    widget_bundle_id=widget_info["CFBundleIdentifier"],
    version=expected_version,
    build_version=expected_build,
    widget_server_url=expected_widget_url,
    executable_sha256=digest(app_bin),
    widget_executable_sha256=digest(widget_bin),
    lock_sha256=digest(build / "app/src-tauri/Cargo.lock"),
    xcode=subprocess.check_output(["xcodebuild", "-version"], text=True).strip(),
    rustc=subprocess.check_output(["rustc", "--version", "--verbose"], text=True).strip(),
    installed=False,
    physical_device="not_checked",
)

(build / "receipt.json").write_text(json.dumps(report, indent=2) + "\n")
if receipt_target:
    with pathlib.Path(receipt_target).open("x") as receipt:
        receipt.write(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
PY
