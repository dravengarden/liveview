// Deterministic, privacy-safe product artwork for the README and website.
//
// The artwork is abstract on purpose: it shows LiveView's structure (shelf,
// reader, synchronized audio, interactive content, publication pipeline)
// without screenshots of any real library. Each scene renders once per theme
// from the Living Book palette in docs/design-system.md.
//
//   bun tools/website-art.ts          write website/assets/art/*.svg
//   bun tools/website-art.ts --check  fail if a committed file has drifted

import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface Palette {
  name: "light" | "dark";
  canvas: string;
  panel: string;
  window: string;
  sidebar: string;
  raised: string;
  line: string;
  ink: string;
  muted: string;
  faint: string;
  plum: string;
  lavender: string;
  plumWash: string;
  amber: string;
  amberWash: string;
  navy: string;
  device: string;
  reader: string;
  glow: string;
}

export const PALETTES: Record<Palette["name"], Palette> = {
  light: {
    name: "light",
    canvas: "#f8f1e5",
    panel: "#f3eadb",
    window: "#fffaf2",
    sidebar: "#f6eee1",
    raised: "#fffdf8",
    line: "#e4d8c4",
    ink: "#17191f",
    muted: "#a59b8b",
    faint: "#d9cdb9",
    plum: "#754b86",
    lavender: "#ae8dde",
    plumWash: "#ece1f3",
    amber: "#f0a51f",
    amberWash: "#fbe6bd",
    navy: "#19376d",
    device: "#17191f",
    reader: "#fffaf2",
    glow: "#ae8dde",
  },
  dark: {
    name: "dark",
    canvas: "#0c1430",
    panel: "#111a3d",
    window: "#141e42",
    sidebar: "#10183a",
    raised: "#1b2650",
    line: "#28345f",
    ink: "#f3ecdf",
    muted: "#6f7799",
    faint: "#2f3b66",
    plum: "#ae8dde",
    lavender: "#c9b2ec",
    plumWash: "#2a2452",
    amber: "#f5bd48",
    amberWash: "#4a3a2a",
    navy: "#6f8fd6",
    device: "#05070f",
    reader: "#151f44",
    glow: "#936dce",
  },
};

// Cover gradients stay identical across themes: artwork is content, not chrome.
const COVERS: [string, string][] = [
  ["#19376d", "#4d72c4"],
  ["#754b86", "#ae8dde"],
  ["#b86e12", "#f5bd48"],
  ["#1f6b63", "#4fb3a1"],
  ["#8a3b4a", "#d9878c"],
  ["#2b2f45", "#62709a"],
  ["#3c294d", "#936dce"],
  ["#0f4c75", "#5aa6dc"],
  ["#5b4a1f", "#c9a24a"],
  ["#4a2f5e", "#c08ad8"],
];

const n = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  extra = "",
): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(r)}" fill="${fill}"${extra}/>`;
}

function line(x: number, y: number, w: number, h: number, fill: string): string {
  return rect(x, y, w, h, h / 2, fill);
}

function circle(cx: number, cy: number, r: number, fill: string, extra = ""): string {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}"${extra}/>`;
}

/** The brand's four-point glint, scaled from web/public/brand-mark.svg. */
export function glint(cx: number, cy: number, s: number, fill: string): string {
  const p = (dx: number, dy: number) => `${n(cx + dx * s)} ${n(cy + dy * s)}`;
  return `<path d="M${p(0, -1)}C${p(0.081, -0.41)} ${p(0.33, -0.125)} ${p(0.92, 0)}C${p(0.33, 0.125)} ${p(0.081, 0.41)} ${p(0, 1)}C${p(-0.081, 0.41)} ${p(-0.33, 0.125)} ${p(-0.92, 0)}C${p(-0.33, -0.125)} ${p(-0.081, -0.41)} ${p(0, -1)}Z" fill="${fill}"/>`;
}

function coverDefs(prefix: string): string {
  return COVERS.map(
    ([from, to], index) =>
      `<linearGradient id="${prefix}c${index}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`,
  ).join("");
}

/** An abstract book cover: gradient, spine highlight, title bars, and a small glint. */
function cover(prefix: string, index: number, x: number, y: number, w: number, h: number) {
  const r = Math.max(4, w * 0.06);
  return [
    rect(x, y, w, h, r, `url(#${prefix}c${index % COVERS.length})`),
    rect(x, y, w * 0.07, h, 0, "#ffffff", ' opacity="0.12"'),
    line(x + w * 0.18, y + h * 0.62, w * 0.62, Math.max(3, h * 0.045), "#fffaf0"),
    line(x + w * 0.18, y + h * 0.72, w * 0.4, Math.max(2, h * 0.03), "#fffaf0"),
    glint(x + w * 0.74, y + h * 0.22, w * 0.11, "#fff7e9"),
  ].join("");
}

function progress(x: number, y: number, w: number, fraction: number, track: string, fill: string) {
  return line(x, y, w, 4, track) + line(x, y, Math.max(4, w * fraction), 4, fill);
}

function waveform(
  x: number,
  y: number,
  w: number,
  h: number,
  bars: number,
  played: number,
  on: string,
  off: string,
): string {
  const step = w / bars;
  const out: string[] = [];
  for (let i = 0; i < bars; i += 1) {
    const amp = 0.25 + 0.75 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.45));
    const bh = Math.max(4, h * amp);
    out.push(line(x + i * step, y + (h - bh) / 2, Math.max(2, step * 0.5), bh, i < played ? on : off));
  }
  return out.join("");
}

function svg(width: number, height: number, label: string, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}">\n${body}\n</svg>\n`;
}

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function text(x: number, y: number, value: string, fill: string, size: number, extra = "") {
  return `<text x="${n(x)}" y="${n(y)}" fill="${fill}" font-family="${MONO}" font-size="${size}" letter-spacing="0.06em"${extra}>${value}</text>`;
}

function phoneFrame(p: Palette, x: number, y: number, w: number, h: number, clip: string) {
  return [
    rect(x + 6, y + 14, w, h, 42, "#000000", ' opacity="0.16"'),
    rect(x, y, w, h, 42, p.device),
    rect(x + 9, y + 9, w - 18, h - 18, 34, p.reader),
    `<clipPath id="${clip}">${rect(x + 9, y + 9, w - 18, h - 18, 34, "#000")}</clipPath>`,
    line(x + w / 2 - 36, y + 22, 72, 18, p.device),
  ].join("");
}

/** Hero: a desktop bookshelf and a phone reading with synchronized audio. */
export function heroArt(p: Palette): string {
  const id = `h${p.name[0]}`;
  const out: string[] = [];
  out.push(
    `<defs>${coverDefs(id)}<radialGradient id="${id}glow" cx="0.85" cy="0.1" r="0.7"><stop offset="0" stop-color="${p.glow}" stop-opacity="0.28"/><stop offset="1" stop-color="${p.glow}" stop-opacity="0"/></radialGradient><radialGradient id="${id}warm" cx="0.05" cy="1" r="0.6"><stop offset="0" stop-color="${p.amber}" stop-opacity="0.18"/><stop offset="1" stop-color="${p.amber}" stop-opacity="0"/></radialGradient><linearGradient id="${id}hero" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#111a3d"/><stop offset="1" stop-color="#3c294d"/></linearGradient><clipPath id="${id}win">${rect(36, 56, 860, 600, 22, "#000")}</clipPath></defs>`,
  );
  out.push(rect(0, 0, 1200, 760, 36, p.panel));
  out.push(rect(0, 0, 1200, 760, 36, `url(#${id}glow)`));
  out.push(rect(0, 0, 1200, 760, 36, `url(#${id}warm)`));

  // Desktop window.
  out.push(rect(42, 70, 860, 600, 22, "#000000", ' opacity="0.10"'));
  out.push(rect(36, 56, 860, 600, 22, p.window, ` stroke="${p.line}" stroke-width="1.5"`));
  out.push(`<g clip-path="url(#${id}win)">`);
  out.push(rect(36, 56, 860, 44, 0, p.sidebar));
  out.push(line(36, 99, 860, 1.5, p.line));
  for (const [i, cx] of [62, 80, 98].entries()) out.push(circle(cx, 78, 5.5, i === 0 ? p.amber : p.faint));
  out.push(rect(330, 66, 300, 24, 12, p.window, ` stroke="${p.line}"`));
  out.push(circle(348, 78, 5, "none", ` stroke="${p.muted}" stroke-width="2"`));
  out.push(line(362, 75, 110, 6, p.faint));

  // Sidebar: collections.
  out.push(rect(36, 100, 200, 556, 0, p.sidebar));
  out.push(line(235, 100, 1.5, 556, p.line));
  out.push(glint(66, 130, 10, p.amber));
  out.push(line(84, 126, 92, 8, p.ink));
  out.push(line(56, 168, 60, 5, p.muted));
  const rows = [0.8, 0.62, 0.7, 0.5, 0.66, 0.56, 0.74];
  rows.forEach((width, i) => {
    const y = 188 + i * 40;
    if (i === 1) out.push(rect(48, y - 9, 176, 34, 10, p.plumWash));
    out.push(rect(60, y, 16, 16, 5, i === 1 ? p.plum : p.faint));
    out.push(line(86, y + 5, 120 * width, 6, i === 1 ? p.plum : p.muted));
  });

  // Continue reading banner.
  out.push(rect(256, 120, 620, 150, 18, `url(#${id}hero)`));
  out.push(glint(842, 146, 12, "#f5bd48"));
  out.push(glint(818, 170, 6, "#ae8dde"));
  out.push(cover(id, 1, 276, 136, 88, 118));
  out.push(line(384, 150, 70, 6, "#ae8dde"));
  out.push(line(384, 170, 230, 12, "#fff7e9"));
  out.push(line(384, 192, 170, 12, "#fff7e9"));
  out.push(progress(384, 228, 260, 0.58, "#3b3f6b", "#f5bd48"));
  out.push(circle(824, 230, 22, "#f5bd48"));
  out.push(`<path d="M817 219 L835 230 L817 241Z" fill="#111a3d"/>`);

  // Shelf header and filter chips.
  out.push(line(256, 298, 120, 9, p.ink));
  [70, 56, 84].forEach((w, i) => {
    const x = 640 + [0, 80, 146][i];
    out.push(rect(x, 290, w, 24, 12, i === 0 ? p.plum : p.window, i === 0 ? "" : ` stroke="${p.line}"`));
    out.push(line(x + 14, 299, w - 28, 6, i === 0 ? "#fffaf0" : p.muted));
  });

  // Cover grid.
  const fractions = [0.82, 0.35, 1, 0.12, 0.6, 0.47, 0.9, 0.2, 0.71, 0.05];
  for (let i = 0; i < 10; i += 1) {
    const col = i % 5;
    const row = Math.floor(i / 5);
    const x = 256 + col * 126;
    const y = 334 + row * 214;
    out.push(cover(id, i + 2, x, y, 104, 140));
    out.push(line(x, y + 152, 92, 7, p.ink));
    out.push(line(x, y + 166, 60, 6, p.muted));
    out.push(progress(x, y + 182, 104, fractions[i], p.faint, i % 3 === 1 ? p.amber : p.plum));
  }
  out.push("</g>");

  // Phone reader with synchronized audio.
  const px = 868;
  const py = 150;
  const pw = 290;
  const ph = 590;
  out.push(phoneFrame(p, px, py, pw, ph, `${id}phone`));
  out.push(`<g clip-path="url(#${id}phone)">`);
  out.push(line(px + 30, py + 64, 76, 6, p.plum));
  out.push(line(px + 30, py + 84, 210, 13, p.ink));
  out.push(line(px + 30, py + 106, 150, 13, p.ink));
  const para = [220, 200, 226, 184];
  para.forEach((w, i) => out.push(line(px + 30, py + 140 + i * 18, w, 6, p.faint)));
  // The sentence being spoken.
  out.push(rect(px + 22, py + 214, 246, 46, 8, p.amberWash));
  out.push(line(px + 30, py + 224, 218, 7, p.ink));
  out.push(line(px + 30, py + 242, 150, 7, p.ink));
  out.push(line(px + 22, py + 262, 120, 3, p.amber));
  [210, 230, 170].forEach((w, i) => out.push(line(px + 30, py + 284 + i * 18, w, 6, p.faint)));
  // A diagram that stays a diagram.
  out.push(rect(px + 22, py + 346, 246, 96, 12, p.raised, ` stroke="${p.line}"`));
  const nodes = [
    [px + 62, py + 372],
    [px + 145, py + 372],
    [px + 228, py + 372],
    [px + 104, py + 418],
    [px + 186, py + 418],
  ];
  out.push(
    `<path d="M${nodes[0][0]} ${nodes[0][1]}H${nodes[2][0]}M${nodes[0][0]} ${nodes[0][1]}L${nodes[3][0]} ${nodes[3][1]}M${nodes[1][0]} ${nodes[1][1]}L${nodes[4][0]} ${nodes[4][1]}M${nodes[3][0]} ${nodes[3][1]}H${nodes[4][0]}" stroke="${p.muted}" stroke-width="2" fill="none"/>`,
  );
  nodes.forEach(([cx, cy], i) =>
    out.push(rect(cx - 22, cy - 11, 44, 22, 7, i === 1 ? p.plum : p.window, i === 1 ? "" : ` stroke="${p.lavender}" stroke-width="1.5"`)),
  );
  // Audio dock.
  out.push(rect(px + 9, py + 462, pw - 18, 119, 0, p.raised));
  out.push(line(px + 9, py + 462, pw - 18, 1.5, p.line));
  out.push(waveform(px + 30, py + 478, 230, 30, 34, 15, p.amber, p.faint));
  out.push(line(px + 30, py + 522, 26, 5, p.muted));
  out.push(line(px + 234, py + 522, 26, 5, p.muted));
  out.push(circle(px + pw / 2, py + 546, 20, p.plum));
  out.push(rect(px + pw / 2 - 7, py + 538, 5, 16, 2, "#fffaf0"));
  out.push(rect(px + pw / 2 + 2, py + 538, 5, 16, 2, "#fffaf0"));
  out.push(circle(px + 82, py + 546, 13, "none", ` stroke="${p.muted}" stroke-width="2"`));
  out.push(circle(px + 208, py + 546, 13, "none", ` stroke="${p.muted}" stroke-width="2"`));
  out.push("</g>");

  // Brand glints.
  out.push(glint(1112, 84, 30, p.amber));
  out.push(glint(1064, 64, 13, p.name === "light" ? "#ffffff" : "#fff7e9"));
  out.push(glint(1150, 128, 11, p.lavender));
  return svg(
    1200,
    760,
    "Abstract LiveView desktop bookshelf and a phone reader with a highlighted spoken sentence, a diagram, and an audio player",
    out.join("\n"),
  );
}

/** Three phones: discover, explore interactive content, listen. */
export function mobileArt(p: Palette): string {
  const id = `m${p.name[0]}`;
  const out: string[] = [];
  out.push(
    `<defs>${coverDefs(id)}<radialGradient id="${id}glow" cx="0.5" cy="0.2" r="0.7"><stop offset="0" stop-color="${p.glow}" stop-opacity="0.22"/><stop offset="1" stop-color="${p.glow}" stop-opacity="0"/></radialGradient><linearGradient id="${id}area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.lavender}" stop-opacity="0.45"/><stop offset="1" stop-color="${p.lavender}" stop-opacity="0"/></linearGradient></defs>`,
  );
  out.push(rect(0, 0, 1200, 720, 36, p.panel));
  out.push(rect(0, 0, 1200, 720, 36, `url(#${id}glow)`));
  const W = 290;
  const H = 600;

  // 1. Library.
  {
    const x = 92;
    const y = 72;
    out.push(phoneFrame(p, x, y, W, H, `${id}p1`));
    out.push(`<g clip-path="url(#${id}p1)">`);
    out.push(line(x + 28, y + 60, 110, 12, p.ink));
    out.push(rect(x + 24, y + 86, W - 48, 34, 12, p.raised, ` stroke="${p.line}"`));
    out.push(line(x + 44, y + 100, 90, 6, p.faint));
    [56, 70, 48].forEach((w, i) => {
      const cx = x + 24 + [0, 66, 146][i];
      out.push(rect(cx, y + 132, w, 22, 11, i === 0 ? p.plum : p.raised, i === 0 ? "" : ` stroke="${p.line}"`));
    });
    out.push(rect(x + 24, y + 168, W - 48, 92, 14, p.raised, ` stroke="${p.line}"`));
    out.push(cover(id, 0, x + 36, y + 178, 54, 72));
    out.push(line(x + 102, y + 190, 120, 8, p.ink));
    out.push(line(x + 102, y + 206, 80, 6, p.muted));
    out.push(progress(x + 102, y + 236, 136, 0.64, p.faint, p.amber));
    for (let i = 0; i < 4; i += 1) {
      const cx = x + 24 + (i % 2) * 124;
      const cy = y + 280 + Math.floor(i / 2) * 150;
      out.push(cover(id, i + 3, cx, cy, 106, 108));
      out.push(line(cx, cy + 118, 86, 6, p.ink));
      out.push(progress(cx, cy + 132, 106, [0.3, 0.9, 0.55, 0.1][i], p.faint, p.plum));
    }
    out.push(rect(x + 9, y + H - 70, W - 18, 61, 0, p.raised));
    [0, 1, 2, 3].forEach((i) =>
      out.push(rect(x + 50 + i * 56, y + H - 52, 18, 18, 6, i === 0 ? p.plum : p.faint)),
    );
    out.push("</g>");
  }

  // 2. Interactive view.
  {
    const x = 455;
    const y = 48;
    out.push(phoneFrame(p, x, y, W, H, `${id}p2`));
    out.push(`<g clip-path="url(#${id}p2)">`);
    out.push(line(x + 28, y + 62, 64, 6, p.plum));
    out.push(line(x + 28, y + 80, 200, 12, p.ink));
    [210, 180].forEach((w, i) => out.push(line(x + 28, y + 108 + i * 16, w, 6, p.faint)));
    [0, 1, 2].forEach((i) => {
      const cx = x + 24 + i * 82;
      out.push(rect(cx, y + 152, 74, 62, 12, p.raised, ` stroke="${p.line}"`));
      out.push(line(cx + 12, y + 166, 34, 5, p.muted));
      out.push(line(cx + 12, y + 184, 46, 14, i === 1 ? p.amber : p.ink));
    });
    [0.62, 0.34].forEach((value, i) => {
      const cy = y + 244 + i * 40;
      out.push(line(x + 28, cy - 14, 70, 5, p.muted));
      out.push(line(x + 28, cy, 234, 6, p.faint));
      out.push(line(x + 28, cy, 234 * value, 6, p.plum));
      out.push(circle(x + 28 + 234 * value, cy + 3, 10, p.raised, ` stroke="${p.plum}" stroke-width="3"`));
    });
    out.push(rect(x + 24, y + 318, W - 48, 190, 14, p.raised, ` stroke="${p.line}"`));
    for (let i = 0; i < 4; i += 1) out.push(line(x + 40, y + 350 + i * 40, 210, 1, p.line));
    const cx0 = x + 40;
    const cy0 = y + 480;
    const pts = [0, 14, 52, 38, 82, 70, 118, 96, 104, 140].map((v, i) => [cx0 + i * 23.3, cy0 - v]);
    const path = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${n(px)} ${n(py)}`).join("");
    out.push(`<path d="${path}L${n(pts.at(-1)?.[0] ?? 0)} ${cy0}L${cx0} ${cy0}Z" fill="url(#${id}area)"/>`);
    out.push(`<path d="${path}" fill="none" stroke="${p.plum}" stroke-width="3.5" stroke-linejoin="round"/>`);
    out.push(circle(pts[7][0], pts[7][1], 7, p.amber, ` stroke="${p.raised}" stroke-width="3"`));
    [190, 150].forEach((w, i) => out.push(line(x + 28, y + 530 + i * 16, w, 6, p.faint)));
    out.push("</g>");
  }

  // 3. Listen.
  {
    const x = 818;
    const y = 72;
    out.push(phoneFrame(p, x, y, W, H, `${id}p3`));
    out.push(`<g clip-path="url(#${id}p3)">`);
    out.push(cover(id, 6, x + 55, y + 56, 180, 196));
    out.push(line(x + 50, y + 274, 190, 12, p.ink));
    out.push(line(x + 85, y + 296, 120, 7, p.muted));
    out.push(line(x + 30, y + 330, 210, 6, p.faint));
    out.push(rect(x + 22, y + 346, 246, 42, 8, p.amberWash));
    out.push(line(x + 30, y + 356, 220, 7, p.ink));
    out.push(line(x + 30, y + 372, 140, 7, p.ink));
    out.push(line(x + 30, y + 400, 196, 6, p.faint));
    out.push(waveform(x + 30, y + 428, 230, 28, 34, 20, p.amber, p.faint));
    out.push(line(x + 30, y + 468, 26, 5, p.muted));
    out.push(line(x + 234, y + 468, 26, 5, p.muted));
    out.push(circle(x + W / 2, y + 516, 28, p.plum));
    out.push(`<path d="M${x + W / 2 - 8} ${y + 502}L${x + W / 2 + 14} ${y + 516}L${x + W / 2 - 8} ${y + 530}Z" fill="#fffaf0"/>`);
    out.push(circle(x + 66, y + 516, 16, "none", ` stroke="${p.muted}" stroke-width="2.5"`));
    out.push(circle(x + 224, y + 516, 16, "none", ` stroke="${p.muted}" stroke-width="2.5"`));
    out.push(rect(x + W / 2 - 26, y + 552, 52, 20, 10, p.raised, ` stroke="${p.line}"`));
    out.push("</g>");
  }
  out.push(glint(1140, 64, 22, p.amber));
  out.push(glint(1102, 44, 9, p.lavender));
  return svg(
    1200,
    720,
    "Three abstract LiveView phone screens: a bookshelf with progress, an interactive chart with sliders and metrics, and an audiobook player with a highlighted sentence",
    out.join("\n"),
  );
}

/** Publication pipeline: authored files → check → content DAG → readers. */
export function pipelineArt(p: Palette): string {
  const id = `p${p.name[0]}`;
  const out: string[] = [];
  out.push(`<defs>${coverDefs(id)}</defs>`);
  out.push(rect(0, 0, 1200, 380, 32, p.panel));
  const cardY = 60;
  const cardH = 260;
  const cards = [40, 330, 620, 910];
  cards.forEach((x, i) => {
    out.push(rect(x, cardY, 250, cardH, 22, i === 2 ? p.window : p.raised, ` stroke="${i === 2 ? p.plum : p.line}" stroke-width="${i === 2 ? 2 : 1.5}"`));
    out.push(text(x + 22, cardY + 34, `0${i + 1}`, p.muted, 13));
    out.push(text(x + 52, cardY + 34, ["library/", "liveview check", "content DAG", "web · native"][i], p.ink, 13, ' font-weight="600"'));
    if (i < 3) {
      out.push(`<path d="M${x + 258} ${cardY + cardH / 2}H${x + 284}" stroke="${p.muted}" stroke-width="2" stroke-dasharray="4 5"/>`);
      out.push(`<path d="M${x + 280} ${cardY + cardH / 2 - 6}L${x + 288} ${cardY + cardH / 2}L${x + 280} ${cardY + cardH / 2 + 6}" stroke="${p.muted}" stroke-width="2" fill="none"/>`);
    }
  });

  // 01 Source files.
  const files = ["book.toml", "en/01-intro.md", "zh/01-intro.md", "figures/flow.svg", "audio/en/…spoken.md"];
  files.forEach((name, i) => {
    const y = cardY + 62 + i * 36;
    const color = [p.amber, p.plum, p.plum, p.navy, p.amber][i];
    out.push(rect(62, y, 18, 22, 4, color, ' opacity="0.9"'));
    out.push(text(92, y + 16, name, p.ink, 12));
  });

  // 02 Checks.
  ["Markdown + assets", "Mermaid · SVG · Typst", "KaTeX math", "narration coverage", "warning baseline"].forEach(
    (name, i) => {
      const y = cardY + 74 + i * 36;
      out.push(circle(362, y, 10, p.plumWash));
      out.push(`<path d="M357 ${y}l3.5 3.5 6.5-7" stroke="${p.plum}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
      out.push(text(382, y + 4, name, p.ink, 12));
    },
  );

  // 03 Merkle DAG with one changed path.
  const root: [number, number] = [745, cardY + 82];
  const mid: [number, number][] = [
    [690, cardY + 150],
    [800, cardY + 150],
  ];
  const leaves: [number, number][] = [
    [660, cardY + 220],
    [720, cardY + 220],
    [770, cardY + 220],
    [830, cardY + 220],
  ];
  const edges: [[number, number], [number, number], boolean][] = [
    [root, mid[0], false],
    [root, mid[1], true],
    [mid[0], leaves[0], false],
    [mid[0], leaves[1], false],
    [mid[1], leaves[2], true],
    [mid[1], leaves[3], false],
  ];
  for (const [[x1, y1], [x2, y2], hot] of edges) {
    out.push(`<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${hot ? p.amber : p.faint}" stroke-width="${hot ? 3 : 2}"/>`);
  }
  const node = ([x, y]: [number, number], hot: boolean, size = 13) =>
    out.push(rect(x - size, y - size, size * 2, size * 2, 7, hot ? p.amber : p.raised, hot ? "" : ` stroke="${p.lavender}" stroke-width="2"`));
  node(root, true, 16);
  node(mid[0], false);
  node(mid[1], true);
  leaves.forEach((leaf, i) => node(leaf, i === 2, 11));
  out.push(glint(root[0] + 34, root[1] - 18, 9, p.amber));

  // 04 Readers.
  out.push(rect(926, cardY + 66, 150, 104, 10, p.window, ` stroke="${p.line}" stroke-width="1.5"`));
  out.push(line(926, cardY + 84, 150, 1.5, p.line));
  [0, 1, 2].forEach((i) => out.push(cover(id, i, 940 + i * 44, cardY + 96, 34, 46)));
  out.push(progress(940, cardY + 154, 122, 0.5, p.faint, p.plum));
  out.push(rect(1084, cardY + 58, 64, 124, 14, p.device));
  out.push(rect(1089, cardY + 63, 54, 114, 10, p.reader));
  out.push(rect(1093, cardY + 98, 46, 16, 3, p.amberWash));
  [80, 120, 140].forEach((yy) => out.push(line(1096, cardY + yy, 40, 4, p.faint)));
  out.push(waveform(1096, cardY + 150, 40, 12, 10, 5, p.amber, p.faint));
  out.push(rect(940, cardY + 200, 196, 34, 17, p.plumWash));
  out.push(`<path d="M960 ${cardY + 217}l5 5 9-10" stroke="${p.plum}" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
  out.push(text(984, cardY + 222, "verified offline", p.plum, 12, ' font-weight="600"'));
  return svg(
    1200,
    380,
    "LiveView publication pipeline: an authored library folder, renderer-compatible checks, an incremental content-addressed DAG where only the changed path is updated, and web and native readers with verified offline copies",
    out.join("\n"),
  );
}

export const SCENES = {
  hero: heroArt,
  mobile: mobileArt,
  pipeline: pipelineArt,
} as const;

export function renderAll(): Map<string, string> {
  const files = new Map<string, string>();
  for (const [scene, render] of Object.entries(SCENES)) {
    for (const palette of Object.values(PALETTES)) {
      files.set(`liveview-${scene}-${palette.name}.svg`, render(palette));
    }
  }
  return files;
}

export const ART_DIR = new URL("../website/assets/art/", import.meta.url);

if (import.meta.main) {
  const check = process.argv.includes("--check");
  await mkdir(ART_DIR, { recursive: true });
  let drift = 0;
  for (const [name, content] of renderAll()) {
    const target = new URL(name, ART_DIR);
    if (check) {
      const current = await readFile(target, "utf8").catch(() => "");
      if (current !== content) {
        console.error(`website art drift: ${name}; run bun tools/website-art.ts`);
        drift += 1;
      }
    } else {
      await writeFile(target, content);
    }
  }
  if (drift > 0) process.exit(1);
  console.log(check ? "website art is current" : `wrote ${renderAll().size} artwork files`);
}
