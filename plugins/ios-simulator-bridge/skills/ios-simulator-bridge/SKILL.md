---
name: ios-simulator-bridge
description: Operate and diagnose a Mac-hosted iOS Simulator from a remote Codex host using SSH and a project-owned helper. Use for simulator boot, install, launch, WebView DOM inspection, appearance changes, screenshots, logs, or remote bridge failures; use the owning project's closer skill for build commands and acceptance criteria.
---

# Operate a remote iOS Simulator

Keep ownership split:

- This plugin owns generic SSH transport and Simulator evidence conventions.
- The project owns bundle ID, source sync, build helper, selectors, expected
  origin, and acceptance checks.
- The host owns Xcode, simulator devices, SSH identity, and physical-device
  provisioning.

Run the bundled resolver with a project-owned remote helper:

```bash
"${CODEX_PLUGIN_ROOT}/scripts/ios-sim-remote" <remote-helper> status
"${CODEX_PLUGIN_ROOT}/scripts/ios-sim-remote" <remote-helper> launch
"${CODEX_PLUGIN_ROOT}/scripts/ios-sim-remote" <remote-helper> eval 'document.title'
"${CODEX_PLUGIN_ROOT}/scripts/ios-sim-remote" <remote-helper> shot
```

Set `IOS_SIM_MAC_HOST` only when the SSH alias is not `macbook-air`. Prefer
selector-driven DOM interaction over pixel taps. Use DOM/computed styles for
behavior claims and screenshots for visual claims. Confirm app origin, target,
and iPhone user agent before trusting results.

If SSH fails, diagnose the host connection. If the helper fails, follow the
owning project's build/relaunch path. Do not install Xcode, rewrite project
configuration, or operate physical devices as an inferred repair.
