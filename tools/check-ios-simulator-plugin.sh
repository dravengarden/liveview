#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
plugin="$root/plugins/ios-simulator-bridge"

python3 - "$plugin" "$root/.agents/plugins/marketplace.json" <<'PY'
import json
import pathlib
import sys

plugin = pathlib.Path(sys.argv[1])
manifest = json.loads((plugin / ".codex-plugin/plugin.json").read_text())
marketplace = json.loads(pathlib.Path(sys.argv[2]).read_text())
assert manifest["name"] == "ios-simulator-bridge"
assert (plugin / "skills/ios-simulator-bridge/SKILL.md").is_file()
entry = next(p for p in marketplace["plugins"] if p["name"] == manifest["name"])
assert entry["source"]["path"] == "./plugins/ios-simulator-bridge"
PY

test -x "$plugin/scripts/ios-sim-remote"
echo "ios simulator bridge plugin ok"
