#!/usr/bin/env bash
# Regenerate every launcher icon from the canonical opaque SVG.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT/web/public/app-icon.svg"

command -v magick >/dev/null || {
  echo "error: ImageMagick (magick) is required" >&2
  exit 1
}
command -v png2icns >/dev/null || {
  echo "error: libicns (png2icns) is required" >&2
  exit 1
}

render_png() {
  local target="$1" size
  size="$(magick identify -format '%wx%h' "$target")"
  magick -background none "$SOURCE" -resize "$size" -alpha on \
    -type TrueColorAlpha -define png:color-type=6 "PNG32:$target"
  local channels
  channels="$(magick identify -format '%[channels]' "$target")"
  [[ "$channels" == *rgba* ]] || {
    echo "error: $target is not RGBA ($channels)" >&2
    exit 1
  }
}

while IFS= read -r target; do
  render_png "$target"
done < <(
  find \
    "$ROOT/app/src-tauri/icons" \
    "$ROOT/app/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset" \
    -maxdepth 1 -type f -name '*.png' -print
  printf '%s\n' \
    "$ROOT/web/public/apple-touch-icon.png" \
    "$ROOT/web/public/icon-192.png" \
    "$ROOT/web/public/icon-512.png" \
    "$ROOT/web/public/maskable-512.png" \
    "$ROOT/website/assets/apple-touch-icon.png"
)

magick "$SOURCE" -define icon:auto-resize=256,128,64,48,32,16 \
  "$ROOT/app/src-tauri/icons/icon.ico"

icns_dir="$(mktemp -d)"
trap 'rm -rf "$icns_dir"' EXIT
icns_inputs=()
for size in 16 32 128 256 512 1024; do
  target="$icns_dir/icon-${size}.png"
  magick -background none "$SOURCE" -resize "${size}x${size}" \
    -alpha on -type TrueColorAlpha -define png:color-type=6 "PNG32:$target"
  icns_inputs+=("$target")
done
png2icns "$ROOT/app/src-tauri/icons/icon.icns" "${icns_inputs[@]}"

echo "LiveView brand icons regenerated"
