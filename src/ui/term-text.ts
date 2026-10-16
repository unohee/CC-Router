/**
 * Terminal text that has to fit.
 *
 * The status dashboard draws into whatever pane it lands in (a tmux cell can be
 * 80x20). Ink wraps a line that is too wide into extra lines, and a frame taller
 * than the terminal scrolls its top away, so every line is measured and cut to
 * the pane here, before it reaches Ink, instead of being left to wrap.
 *
 * Width is counted in terminal cells, not UTF-16 units: a Hangul or CJK
 * character takes two cells, a combining mark none. There is no dependency for
 * this on purpose; the table below covers what log text realistically holds.
 */

/** One run of text in one style. A line is a list of these. */
export interface Seg {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
  bg?: string;
}

export function seg(text: string, color?: string, style: Omit<Seg, "text" | "color"> = {}): Seg {
  return color === undefined ? { text, ...style } : { text, color, ...style };
}

function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f)
    || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0xfeff) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0xa4cf)
    || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff)
    || (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Terminal cells a string occupies. */
export function cellWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

export function segsWidth(segs: readonly Seg[]): number {
  let w = 0;
  for (const s of segs) w += cellWidth(s.text);
  return w;
}

/** Cut `text` to at most `max` cells, ending in "…" when anything was removed. */
export function truncateCells(text: string, max: number): string {
  if (max <= 0) return "";
  if (cellWidth(text) <= max) return text;
  let out = "";
  let w = 0;
  for (const ch of text) {
    const cw = charWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** Exactly `width` cells: cut with "…" if long, padded with spaces if short. */
export function padCells(text: string, width: number, align: "left" | "right" = "left"): string {
  const cut = truncateCells(text, width);
  const gap = " ".repeat(Math.max(0, width - cellWidth(cut)));
  return align === "left" ? cut + gap : gap + cut;
}

/** A line cut to `max` cells; the segment that crosses the edge ends in "…". */
export function fitSegs(segs: readonly Seg[], max: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    const w = cellWidth(s.text);
    if (used + w <= max) {
      out.push(s);
      used += w;
      continue;
    }
    const room = max - used;
    if (room > 0) out.push({ ...s, text: truncateCells(s.text, room) });
    break;
  }
  return out;
}

/** Control characters can move the cursor or repaint the screen; none belongs in a log line. */
export function terminalSafeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
}
