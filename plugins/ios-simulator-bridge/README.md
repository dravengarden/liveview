# iOS Simulator Bridge Codex plugin

This plugin supplies the generic remote Mac/Simulator control layer. Projects
retain their build scripts, bundle identity, selectors, and acceptance tests.
It intentionally has no MCP server: SSH and deterministic project helpers are
the narrower current integration.

From the LiveView root:

```bash
codex plugin marketplace add .
codex plugin add ios-simulator-bridge@liveview-development
```
