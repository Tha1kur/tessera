/**
 * Terminal formatting.
 *
 * Colour is disabled when output is piped, when NO_COLOR is set, or when the
 * terminal says it cannot handle it - so `tess log | grep` sees clean text
 * rather than escape sequences.
 */

const enabled =
  process.stdout.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const wrap = (open: number, close: number) => (text: string) =>
  enabled ? `[${open}m${text}[${close}m` : text;

export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

/** A short, readable commit id. Twelve characters is plenty in practice. */
export function shortId(id: string): string {
  return id.slice(0, 12);
}

/** Format a timestamp the way a human reads it. */
export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "3 minutes ago", for log output where exact times are noise. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 60) return "just now";

  const units: [label: string, seconds: number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];

  for (const [label, size] of units) {
    const value = Math.floor(seconds / size);
    if (value >= 1) return `${value} ${label}${value === 1 ? "" : "s"} ago`;
  }

  /* c8 ignore next - anything under a minute returned above. */
  return "just now";
}

/** Colourise a unified diff so additions and deletions stand out. */
export function paintPatch(patch: string): string {
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return style.bold(line);
      if (line.startsWith("@@")) return style.cyan(line);
      if (line.startsWith("+")) return style.green(line);
      if (line.startsWith("-")) return style.red(line);
      return line;
    })
    .join("\n");
}

/** Pad a string to a width, for column output. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}
