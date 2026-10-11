/** Measured off graphify's rendered page (reposhape's docs/graph-rendering.md). */
export type ColorScheme = "dark" | "light";

/**
 * Everything about the canvas that is colour, per scheme. Chrome follows CSS
 * variables; the canvas cannot, because its colours are pre-composited data
 * (an edge's ink is mixed against the ground by hand).
 *
 * The two schemes are symmetric in derivation, not in values. Dark lifts discs
 * to full value because the palette arrives muted; light keeps the raw Tableau
 * 10, which was designed on white. Selection is the value no group can claim
 * on that ground: white on dark, near-black on light. Dimming moves toward the
 * canvas on both, never toward white, never toward black.
 */
export const SCHEMES = {
  dark: {
    ground: "#0f0f1a",
    dimNode: "#1e1e2b",
    selected: "#ffffff",
    label: "#c9c9d8",
    labelFocused: "#ffffff",
    hoverGround: "#141422",
    isolated: "#ababaf",
    fallback: "#5c5c72",
    runtimeLink: "#e0a93e",
  },
  light: {
    ground: "#eef0f4",
    dimNode: "#dde1e9",
    selected: "#11131a",
    label: "#565b6b",
    labelFocused: "#11131a",
    hoverGround: "#ffffff",
    isolated: "#68707e",
    fallback: "#5c5c72",
    runtimeLink: "#a8700a",
  },
} as const satisfies Record<
  ColorScheme,
  {
    ground: string;
    dimNode: string;
    selected: string;
    label: string;
    labelFocused: string;
    hoverGround: string;
    isolated: string;
    fallback: string;
    /** One hue for every runtime link: it is a kind, not a group. */
    runtimeLink: string;
  }
>;

/** Push a hex to full value (brightness 100%): hue and saturation stay, the
 * strongest channel hits 255. Group colours arrive muted; at full value they
 * read vivid without collapsing into white. */
export function fullValue(hex: string): string {
  let h = hex.startsWith("#") ? hex.slice(1) : hex;
  if (h.length === 3) h = h.slice(0, 1).repeat(2) + h.slice(1, 2).repeat(2) + h.slice(2, 3).repeat(2);
  const channels = [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
  const peak = Math.max(...channels);
  if (peak === 0) return hex;
  const scale = 255 / peak;
  const out = (n: number) => Math.min(255, Math.round(n * scale)).toString(16).padStart(2, "0");
  return `#${out(channels[0]!)}${out(channels[1]!)}${out(channels[2]!)}`;
}

/** Mix a foreground hex toward a ground hex; result is `#rrggbb`. */
export function mixHex(foreground: string, ground: string, groundFraction: number): string {
  const channels = (hex: string): [number, number, number] => {
    let h = hex.startsWith("#") ? hex.slice(1) : hex;
    if (h.length === 3) h = h.slice(0, 1).repeat(2) + h.slice(1, 2).repeat(2) + h.slice(2, 3).repeat(2);
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  };
  const [fr, fg, fb] = channels(foreground);
  const [gr, gg, gb] = channels(ground);
  const mix = (f: number, g: number) =>
    Math.max(0, Math.min(255, Math.round(f + (g - f) * groundFraction)));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(mix(fr, gr))}${hex(mix(fg, gg))}${hex(mix(fb, gb))}`;
}

/** A group's disc ink on a scheme. Dark lifts the muted palette to full
 * value (hue and saturation stay, so groups keep their identity, but nothing
 * renders muted); light keeps raw Tableau 10, which was designed on white. */
export function discColor(groupHex: string, scheme: ColorScheme): string {
  return scheme === "dark" ? fullValue(groupHex) : groupHex;
}
