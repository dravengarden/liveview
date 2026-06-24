// Headless WebKit-Inspector client for the liveview iOS-simulator WebView.
// Runs ON the Mac (node ≥21 has a global WebSocket). ios_webkit_debug_proxy
// (iwdp) bridges the simulator's webinspectord to a CDP-compatible WS at
// ws://localhost:9222/devtools/page/<id>; this speaks just enough of that
// protocol to (a) eval JS in the live app and (b) stream console output —
// i.e. give an agent real devtools on the running native shell, headlessly.
//
// Used by tools/lvsim.sh (`lvsim eval` / `lvsim console`); see that script and
// the .agents/skills/ios-sim-dev skill for the full loop. Requires the WebView
// to be inspectable — DEBUG builds set WKWebView.inspectable=YES in
// gen/apple/Sources/liveview-app/LiveviewNativeTweaks.mm (iOS 16.4+ opt-in).
//
//   node lv-inspect.mjs eval    <ws-url> '<js expression>'
//   node lv-inspect.mjs console <ws-url>            # stream until killed
const [, , mode, url, expr] = process.argv;
if (!mode || !url) {
  console.error("usage: lv-inspect.mjs <eval|console> <ws-url> [js]");
  process.exit(2);
}

const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) => {
  const id = nextId++;
  pending.set(id, method);
  ws.send(JSON.stringify({ id, method, params }));
  return id;
};

ws.onerror = (e) => {
  console.error("WS error:", e.message || String(e));
  process.exit(1);
};

if (mode === "eval") {
  let evalId;
  ws.onopen = () => {
    // returnByValue serializes the result JSON-side; awaitPromise lets an
    // `async`/Promise expression resolve before we read it back.
    evalId = send("Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id !== evalId) return;
    if (m.result?.exceptionDetails) {
      const ex = m.result.exceptionDetails;
      console.error("JS exception:", ex.text || JSON.stringify(ex));
      process.exit(1);
    }
    const r = m.result?.result;
    const value = r && "value" in r ? r.value : r;
    console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    ws.close();
    process.exit(0);
  };
  setTimeout(() => {
    console.error("timeout (no eval reply in 10s)");
    process.exit(1);
  }, 10000);
} else if (mode === "console") {
  ws.onopen = () => {
    send("Console.enable");
    send("Runtime.enable");
    console.error("[lv-inspect] streaming console — Ctrl-C to stop");
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.method === "Console.messageAdded" && m.params?.message) {
      const msg = m.params.message;
      const where = msg.url ? ` (${msg.url.split("/").pop()}:${msg.line ?? "?"})` : "";
      console.log(`[${msg.level || "log"}] ${msg.text}${where}`);
    } else if (m.method === "Runtime.consoleAPICalled") {
      const a = (m.params.args || [])
        .map((x) => (x && "value" in x ? x.value : (x?.description ?? "")))
        .join(" ");
      console.log(`[${m.params.type || "log"}] ${a}`);
    }
  };
} else {
  console.error(`unknown mode: ${mode}`);
  process.exit(2);
}
