// Pre-mount app-shell splash for web applications.
//
// Returns static HTML/CSS to inject into index.html at build time (e.g. via a
// Vite `transformIndexHtml` plugin): the `head` <style> and the `body` markup
// that goes inside <div id="root">. It paints with the document on any network,
// before the SPA bundle downloads/parses; React's createRoot replaces #root's
// children on mount, so it needs no teardown JS. Themed via prefers-color-scheme
// to avoid a flash on dark.
//
// It is NOT a runtime React component on purpose — it must exist before the app
// (and React) load. Each app wires it once in its vite.config:
//
//   import { splashHtml } from "./src/_shell/splash";
//   const { head, body } = splashHtml({ title: "MyApp" });
//   // plugin: transformIndexHtml(html) =>
//   //   html.replace("</head>", head + "</head>")
//   //       .replace('<div id="root"></div>', `<div id="root">${body}</div>`)

export interface SplashOptions {
  /** App name shown under the spinner. */
  title: string;
  /** Light-scheme background colour (default: warm paper). */
  lightBg?: string;
  /** Light-scheme foreground colour (spinner + title). */
  lightFg?: string;
  /** Dark-scheme background colour (default: GitHub dark). */
  darkBg?: string;
  /** Dark-scheme foreground colour. */
  darkFg?: string;
}

export interface SplashHtml {
  /** <style> block to inject just before </head>. */
  head: string;
  /** Markup to inject inside <div id="root">…</div>. */
  body: string;
}

/** Build the splash <style> + #root markup for the given app. */
export function splashHtml(opts: SplashOptions): SplashHtml {
  const lightBg = opts.lightBg ?? "#fbf7ee";
  const lightFg = opts.lightFg ?? "#6b5b4b";
  const darkBg = opts.darkBg ?? "#0d1117";
  const darkFg = opts.darkFg ?? "#8b949e";

  const head = `<style>
      #app-splash {
        position: fixed; inset: 0; z-index: 9999;
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
        background: ${lightBg}; color: ${lightFg};
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", sans-serif;
      }
      @media (prefers-color-scheme: dark) { #app-splash { background: ${darkBg}; color: ${darkFg}; } }
      #app-splash .app-splash-spinner {
        width: 34px; height: 34px; border: 3px solid currentColor; border-top-color: transparent;
        border-radius: 50%; opacity: 0.65; animation: app-splash-spin 0.8s linear infinite;
      }
      #app-splash .app-splash-title { font-size: 14px; letter-spacing: 0.06em; opacity: 0.75; }
      @keyframes app-splash-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { #app-splash .app-splash-spinner { animation: none; } }
    </style>`;

  const body = `<div id="app-splash" aria-label="Loading" role="status">
        <div class="app-splash-spinner"></div>
        <div class="app-splash-title">${opts.title}</div>
      </div>`;

  return { head, body };
}
