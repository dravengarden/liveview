const MIN_TEXT_CONTRAST = 4.5;

const DARK_LABEL = {
  css: "#111827",
  rgb: { red: 17, green: 24, blue: 39, alpha: 1 },
};
const LIGHT_LABEL = {
  css: "#f8fafc",
  rgb: { red: 248, green: 250, blue: 252, alpha: 1 },
};
const BLACK_LABEL = {
  css: "#000000",
  rgb: { red: 0, green: 0, blue: 0, alpha: 1 },
};
const WHITE_LABEL = {
  css: "#ffffff",
  rgb: { red: 255, green: 255, blue: 255, alpha: 1 },
};

interface RgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

function parseComputedRgb(value: string): RgbaColor | null {
  if (!/^rgba?\(/i.test(value.trim())) return null;
  const channels = value.match(/\d*\.?\d+/g)?.map(Number);
  if (
    !channels || channels.length < 3 ||
    channels.some((channel) => !Number.isFinite(channel))
  ) {
    return null;
  }
  return {
    red: Math.min(255, channels[0]!),
    green: Math.min(255, channels[1]!),
    blue: Math.min(255, channels[2]!),
    alpha: Math.min(1, channels[3] ?? 1),
  };
}

function linearChannel(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(color: RgbaColor): number {
  return 0.2126 * linearChannel(color.red) +
    0.7152 * linearChannel(color.green) +
    0.0722 * linearChannel(color.blue);
}

function contrastRatio(first: RgbaColor, second: RgbaColor): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function composite(foreground: RgbaColor, background: RgbaColor): RgbaColor {
  const alpha = foreground.alpha;
  return {
    red: foreground.red * alpha + background.red * (1 - alpha),
    green: foreground.green * alpha + background.green * (1 - alpha),
    blue: foreground.blue * alpha + background.blue * (1 - alpha),
    alpha: 1,
  };
}

/**
 * Return an accessible replacement for a Mermaid label, or null when its
 * authored/rendered colour already has enough contrast. Computed SVG fills are
 * opaque rgb()/rgba() values; gradients and translucent surfaces are skipped
 * because their real background cannot be inferred safely from one CSS value.
 */
export function readableMermaidLabelColor(
  backgroundCss: string,
  foregroundCss: string,
): string | null {
  const background = parseComputedRgb(backgroundCss);
  const foreground = parseComputedRgb(foregroundCss);
  if (!background || !foreground || background.alpha < 0.98) return null;

  const paintedForeground = foreground.alpha < 1
    ? composite(foreground, background)
    : foreground;
  if (contrastRatio(background, paintedForeground) >= MIN_TEXT_CONTRAST) {
    return null;
  }

  const preferred = [DARK_LABEL, LIGHT_LABEL]
    .map((candidate) => ({
      ...candidate,
      ratio: contrastRatio(background, candidate.rgb),
    }))
    .sort((a, b) => b.ratio - a.ratio)[0]!;
  if (preferred.ratio >= MIN_TEXT_CONTRAST) return preferred.css;

  return [BLACK_LABEL, WHITE_LABEL]
    .map((candidate) => ({
      ...candidate,
      ratio: contrastRatio(background, candidate.rgb),
    }))
    .sort((a, b) => b.ratio - a.ratio)[0]!.css;
}

const NODE_SURFACE_SELECTOR = [
  "rect.label-container",
  "polygon.label-container",
  "path.label-container",
  "circle.label-container",
  "ellipse.label-container",
].join(",");

/**
 * Mermaid's dark theme uses one light label colour for every node. Authors can
 * still supply light semantic fills through classDef/style, producing
 * light-on-light labels. Repair only failing nodes from their rendered fill so
 * dark defaults and author colours that already pass remain untouched. Inline
 * important styles survive the SVG snapshot used by the image lightbox.
 */
export function adaptMermaidLabelContrast(roots: Iterable<Element>): number {
  let adjusted = 0;
  for (const root of roots) {
    for (const node of root.querySelectorAll<SVGGElement>("g.node")) {
      const surface = node.querySelector<SVGElement>(NODE_SURFACE_SELECTOR);
      const label = node.querySelector<HTMLElement | SVGElement>(".nodeLabel");
      if (!surface || !label) continue;

      const labelStyle = getComputedStyle(label);
      const foreground = label.namespaceURI === "http://www.w3.org/2000/svg"
        ? labelStyle.fill
        : labelStyle.color;
      const replacement = readableMermaidLabelColor(
        getComputedStyle(surface).fill,
        foreground,
      );
      if (!replacement) continue;

      const labelParts: (HTMLElement | SVGElement)[] = [
        label,
        ...label.querySelectorAll<HTMLElement | SVGElement>("*"),
      ];
      for (const part of labelParts) {
        part.style.setProperty("color", replacement, "important");
        part.style.setProperty("fill", replacement, "important");
      }
      label.setAttribute("data-lv-contrast-adjusted", "true");
      adjusted += 1;
    }
  }
  return adjusted;
}
