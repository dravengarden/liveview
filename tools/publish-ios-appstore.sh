#!/usr/bin/env bash
# Export and upload one unsigned LiveView iOS release archive recorded by
# tools/build-ios-archive.sh to App Store Connect / TestFlight.
set -euo pipefail

usage() {
  echo "usage: bash tools/publish-ios-appstore.sh /absolute/build/receipt.json [--destination upload|export] [--internal-only] [--receipt-path /absolute/new.json]" >&2
  exit 2
}

if [ "$#" -lt 1 ]; then
  usage
fi

publish_build_receipt="$1"
shift
publish_destination=upload
publish_internal_only=0
publish_report_target=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --destination)
      publish_destination="${2:?--destination requires upload or export}"
      shift 2
      case "$publish_destination" in
        upload|export) ;;
        *) echo "unsupported --destination: $publish_destination (expected upload or export)" >&2; exit 2;;
      esac
      ;;
    --internal-only)
      publish_internal_only=1
      shift
      ;;
    --receipt-path)
      publish_report_target="${2:?--receipt-path requires an absolute path}"
      shift 2
      case "$publish_report_target" in /*) ;; *) echo "receipt path must be absolute" >&2; exit 2;; esac
      test ! -e "$publish_report_target" && test ! -L "$publish_report_target" || {
        echo "refusing to overwrite an App Store release receipt" >&2; exit 1;
      }
      ;;
    *)
      usage
      ;;
  esac
done

test "$(uname -s)" = Darwin || { echo "App Store Connect publication requires a Mac with Xcode" >&2; exit 1; }
test "$(uname -m)" = arm64 || { echo "This release entry targets an arm64 Mac" >&2; exit 1; }

: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID to the 10-character Apple Developer Team ID}"
: "${APPLE_API_KEY_ID:?Set APPLE_API_KEY_ID to the App Store Connect API Key ID}"
: "${APPLE_API_ISSUER_ID:?Set APPLE_API_ISSUER_ID to the App Store Connect API Issuer UUID}"
publish_api_key_path="${APPLE_API_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${APPLE_API_KEY_ID}.p8}"
case "$publish_api_key_path" in /*) ;; *) echo "APPLE_API_KEY_PATH must be an absolute path" >&2; exit 2;; esac
test -f "$publish_api_key_path" || { echo "App Store Connect API key file not found: $publish_api_key_path" >&2; exit 1; }

publish_repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
publish_export_template="$publish_repo/app/src-tauri/gen/apple/ExportOptions.plist"
test -f "$publish_export_template" || { echo "missing ExportOptions.plist template: $publish_export_template" >&2; exit 1; }

python3 - "$publish_build_receipt" "$publish_export_template" "$publish_destination" "$publish_internal_only" "$publish_report_target" "$publish_repo" "$publish_api_key_path" <<'PY'
import hashlib, json, os, pathlib, plistlib, re, shutil, subprocess, sys, tempfile

(
    receipt_arg,
    template_arg,
    destination,
    internal_only_arg,
    report_target,
    repo_arg,
    api_key_path_arg,
) = sys.argv[1:]

internal_only = internal_only_arg == "1"
receipt_path = pathlib.Path(receipt_arg)
if not receipt_path.is_absolute():
    raise SystemExit("build receipt path must be absolute")
receipt_path = receipt_path.resolve(strict=True)
repo_root = pathlib.Path(repo_arg).resolve(strict=True)
api_key_path = pathlib.Path(api_key_path_arg).resolve(strict=True)
if repo_root in api_key_path.parents:
    raise SystemExit("refusing to read an App Store Connect API key stored inside the repository")

team_id = os.environ["APPLE_TEAM_ID"]
api_key_id = os.environ["APPLE_API_KEY_ID"]
api_issuer_id = os.environ["APPLE_API_ISSUER_ID"]
if not re.fullmatch(r"[A-Z0-9]{10}", team_id):
    raise SystemExit("invalid APPLE_TEAM_ID")
if not re.fullmatch(r"[A-Z0-9]{8,16}", api_key_id):
    raise SystemExit("invalid APPLE_API_KEY_ID")
if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", api_issuer_id):
    raise SystemExit("invalid APPLE_API_ISSUER_ID")

build = json.loads(receipt_path.read_text())
if build.get("platform") != "ios" or build.get("profile") != "release":
    raise SystemExit("only release builds from the ios platform can be published to App Store Connect")
if build.get("signing") != "unsigned":
    raise SystemExit("build receipt does not describe an unsigned iOS archive")

out_dir = receipt_path.parent
xcarchive = pathlib.Path(build["xcarchive"]).resolve(strict=True)
try:
    xcarchive.relative_to(out_dir)
except ValueError as exc:
    raise SystemExit("xcarchive path escapes the build receipt directory") from exc
if not xcarchive.is_dir():
    raise SystemExit("xcarchive directory is missing: " + str(xcarchive))

digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
app = xcarchive / "Products/Applications/LiveView.app"
widget = app / "PlugIns/LiveViewWidgets.appex"
app_info = plistlib.loads((app / "Info.plist").read_bytes())
widget_info = plistlib.loads((widget / "Info.plist").read_bytes())
app_bin = app / app_info["CFBundleExecutable"]
widget_bin = widget / widget_info["CFBundleExecutable"]

if digest(app_bin) != build["executable_sha256"]:
    raise SystemExit("archived LiveView executable bytes differ from the build receipt")
if digest(widget_bin) != build["widget_executable_sha256"]:
    raise SystemExit("archived LiveViewWidgets executable bytes differ from the build receipt")
for bundle in (app, widget):
    if (bundle / "_CodeSignature").exists() or (bundle / "embedded.mobileprovision").exists():
        raise SystemExit("unsigned xcarchive unexpectedly carries pre-existing signing artifacts: " + str(bundle))

bundle_id = app_info.get("CFBundleIdentifier")
widget_bundle_id = widget_info.get("CFBundleIdentifier")
version = app_info.get("CFBundleShortVersionString")
build_version = app_info.get("CFBundleVersion")
if (
    bundle_id != build.get("bundle_id")
    or widget_bundle_id != build.get("widget_bundle_id")
    or version != build.get("version")
    or build_version != build.get("build_version")
    or widget_info.get("CFBundleShortVersionString") != version
    or widget_info.get("CFBundleVersion") != build_version
):
    raise SystemExit("archive Info.plist identity/version metadata differs from the build receipt")
if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", str(version or "")):
    raise SystemExit("invalid CFBundleShortVersionString for App Store Connect: " + repr(version))
if not build_version or len(str(build_version)) > 18 or not re.fullmatch(r"(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,2}", str(build_version)):
    raise SystemExit("invalid CFBundleVersion for App Store Connect: " + repr(build_version))

options = plistlib.loads(pathlib.Path(template_arg).read_bytes())
options["method"] = "app-store-connect"
options["destination"] = destination
options["signingStyle"] = "automatic"
options["teamID"] = team_id
options["uploadSymbols"] = True
options["manageAppVersionAndBuildNumber"] = False
if internal_only:
    options["testFlightInternalTestingOnly"] = True
else:
    options.pop("testFlightInternalTestingOnly", None)

export_dir = out_dir / f"appstore-{destination}-{version}-{build_version}"
if export_dir.exists():
    raise SystemExit("refusing to overwrite an existing App Store export directory: " + str(export_dir))

with tempfile.TemporaryDirectory(dir=out_dir) as work:
    options_path = pathlib.Path(work) / "ExportOptions.plist"
    options_path.write_bytes(plistlib.dumps(options, fmt=plistlib.FMT_XML))
    export_dir.mkdir()
    cmd = [
        "xcodebuild",
        "-exportArchive",
        "-archivePath", str(xcarchive),
        "-exportPath", str(export_dir),
        "-exportOptionsPlist", str(options_path),
        "-allowProvisioningUpdates",
        "-authenticationKeyPath", str(api_key_path),
        "-authenticationKeyID", api_key_id,
        "-authenticationKeyIssuerID", api_issuer_id,
    ]
    try:
        subprocess.run(cmd, check=True)
    except Exception:
        shutil.rmtree(export_dir, ignore_errors=True)
        raise

report = dict(
    build_receipt=str(receipt_path),
    build_receipt_sha256=digest(receipt_path),
    source_revision=build["source_revision"],
    executable_sha256=build["executable_sha256"],
    widget_executable_sha256=build["widget_executable_sha256"],
    bundle_id=bundle_id,
    widget_bundle_id=widget_bundle_id,
    version=version,
    build_version=build_version,
    team_id=team_id,
    destination=destination,
    internal_only=internal_only,
    signing="app-store-connect-automatic",
    uploaded=(destination == "upload"),
    xcode=subprocess.check_output(["xcodebuild", "-version"], text=True).strip(),
    installed=False,
    physical_device="not_checked",
)

if destination == "export":
    ipas = sorted(export_dir.glob("*.ipa"))
    if len(ipas) != 1:
        raise SystemExit(f"expected exactly one exported IPA in {export_dir}, found {len(ipas)}")
    ipa = ipas[0]
    report.update(ipa=str(ipa), ipa_sha256=digest(ipa))

(out_dir / "appstore-receipt.json").write_text(json.dumps(report, indent=2) + "\n")
if report_target:
    with pathlib.Path(report_target).open("x") as receipt:
        receipt.write(json.dumps(report, indent=2) + "\n")
print(json.dumps(report, indent=2))
PY
