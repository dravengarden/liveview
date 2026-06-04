// On-demand asset loading.
//
// Heavy renderers (mermaid ~3 MB, highlight.js, later KaTeX) are loaded only
// when a page actually needs them, instead of as parser-blocking <script>s in
// index.html that every visit pays for. Each src/href is injected once and its
// load promise cached, so concurrent callers (e.g. many code blocks) share a
// single load. Resolves on load, rejects on error — callers show a loading
// placeholder while pending and a fallback on failure.

const scripts = new Map<string, Promise<void>>();
const styles = new Map<string, Promise<void>>();

/** Inject a <script src> once; resolves when it has executed. */
export function ensureScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (p) return p;
  p = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => {
      scripts.delete(src); // allow a later retry
      reject(new Error(`Failed to load script ${src}`));
    });
    document.head.appendChild(el);
  });
  scripts.set(src, p);
  return p;
}

/** Inject a <link rel=stylesheet href> once; resolves when it has loaded. */
export function ensureStyle(href: string): Promise<void> {
  let p = styles.get(href);
  if (p) return p;
  p = new Promise<void>((resolve, reject) => {
    const el = document.createElement("link");
    el.rel = "stylesheet";
    el.href = href;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => {
      styles.delete(href);
      reject(new Error(`Failed to load stylesheet ${href}`));
    });
    document.head.appendChild(el);
  });
  styles.set(href, p);
  return p;
}
