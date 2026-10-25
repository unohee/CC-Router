/**
 * How many lines each part of the status dashboard gets in a pane of a given size.
 *
 * The dashboard is read in tmux cells (80x20 and smaller are normal), not on a
 * whole screen. Ink repaints in place only while the frame is shorter than the
 * terminal; a frame as tall as the terminal clears it and scrolls, so the top of
 * the screen, the part that says whether anything is wrong, is what goes first.
 * The plan therefore never spends more than `rows - 1` lines, and what it drops
 * when short is decided here, in the order the operator asked for:
 *
 *   problem strip  >  Ollama quota row  >  managed accounts  >  activity log  >  details
 *
 * Totals, the operations block and the details panel are extras that appear only
 * when there is room left over after those.
 */

export const LOG_VISIBLE = 20;
/** Lines the details block draws: a title and up to five lines of fields. */
export const DETAILS_LINES = 6;
/** Lines the operations block draws. */
export const OPERATIONS_LINES = 5;

export type WidthTier = "wide" | "normal" | "narrow" | "tiny";
export type Region = "activity" | "models";

export interface LayoutInput {
  rows: number;
  cols: number;
  accountCount: number;
  /** One read-only Ollama row alongside the managed account rows. */
  ollamaEnabled?: boolean;
  region: Region;
  /** The operator opened details for the selected log row. */
  detailsOpen: boolean;
}

export interface LayoutPlan {
  /** Lines the frame may use: one fewer than the terminal has. */
  budget: number;
  /** Cells a line may use: one fewer than the terminal is wide, so no line touches the last column. */
  fit: number;
  width: WidthTier;
  /** Too small for anything but the verdict. */
  minimal: boolean;
  accountRows: number;
  /** A "+N more" line follows the accounts. */
  accountFold: boolean;
  ollamaRow: boolean;
  totals: boolean;
  operations: boolean;
  /** The heading line above the activity log or the model list. */
  regionTitle: boolean;
  /** Lines for log rows (activity) or for the rows of the model list (models). */
  regionBody: number;
  details: boolean;
  /** Details were asked for and did not fit; say so instead of silently showing nothing. */
  detailsSuppressed: boolean;
  footer: boolean;
  /** Lines the frame draws in total; never more than `budget`. */
  lines: number;
}

export function widthTier(cols: number): WidthTier {
  if (cols >= 110) return "wide";
  if (cols >= 80) return "normal";
  if (cols >= 60) return "narrow";
  return "tiny";
}

export function planLayout(input: LayoutInput): LayoutPlan {
  const rows = Math.max(1, Math.floor(input.rows));
  const cols = Math.max(1, Math.floor(input.cols));
  const budget = Math.max(1, rows - 1);
  const fit = Math.max(1, cols - 1);
  const width = widthTier(cols);

  const blank: LayoutPlan = {
    budget, fit, width, minimal: true, accountRows: 0, accountFold: false, ollamaRow: false, totals: false,
    operations: false, regionTitle: false, regionBody: 0, details: false, detailsSuppressed: false,
    footer: false, lines: 1,
  };
  if (budget < 2 || cols < 24) return blank;

  const footer = budget >= 3;
  let remaining = budget - 1 - (footer ? 1 : 0);
  const ollamaRow = input.ollamaEnabled === true && remaining > 0;
  if (ollamaRow) remaining--;

  // Accounts come before everything but the strip. When they do not all fit the
  // last line says how many were left out, so the list is never silently short.
  const a = Math.max(0, input.accountCount);
  let accountRows = 0;
  let accountFold = false;
  if (a <= remaining) {
    accountRows = a;
  } else if (remaining >= 2) {
    accountRows = remaining - 1;
    accountFold = true;
  } else {
    accountRows = Math.max(0, remaining);
  }
  remaining -= accountRows + (accountFold ? 1 : 0);

  // What is left is the activity log, or the model list when that was asked for.
  let regionTitle = false;
  let body = 0;
  if (remaining >= 3) {
    regionTitle = true;
    body = remaining - 1;
  }

  let details = false;
  let detailsSuppressed = false;
  if (input.detailsOpen && input.region === "activity") {
    // Keep at least four log rows beside it, or the log has been traded away for it.
    if (body >= DETAILS_LINES + 4) {
      details = true;
      body -= DETAILS_LINES;
    } else {
      detailsSuppressed = true;
    }
  }

  const totals = body >= 14;
  if (totals) body -= 1;

  const operations = cols >= 120 && budget >= 40 && body >= OPERATIONS_LINES + 16;
  if (operations) body -= OPERATIONS_LINES;

  const regionBody = input.region === "activity" ? Math.min(body, LOG_VISIBLE) : body;

  const lines =
    1 + accountRows + (accountFold ? 1 : 0) + (ollamaRow ? 1 : 0) + (totals ? 1 : 0) + (operations ? OPERATIONS_LINES : 0)
    + (regionTitle ? 1 : 0) + regionBody + (details ? DETAILS_LINES : 0) + (footer ? 1 : 0);

  return {
    budget, fit, width, minimal: false, accountRows, accountFold, ollamaRow, totals, operations, regionTitle,
    regionBody, details, detailsSuppressed, footer, lines,
  };
}
