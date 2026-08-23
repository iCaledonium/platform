// ── Money formatting ──────────────────────────────────────────────────────────
//
// Session 150 — one formatter, used everywhere an amount is shown.
//
// Amounts were previously formatted by whatever each call site reached for:
// bare toLocaleString() (browser locale, so it changed per user), and
// toLocaleString("sv-SE") (space-separated). The same salary could therefore
// render as 80,000 / 80 000 / 80000 on three screens of the same app.
//
// The house style is a dot as the thousands separator — 80.000 — so it is fixed
// here rather than left to the browser.
const GROUPED = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

/** 80000 -> "80.000". Rounds; non-numbers become "0". */
export function fmtAmount(n) {
  const v = Number(n);
  return GROUPED.format(Number.isFinite(v) ? Math.round(v) : 0);
}

/** 80000, "SEK" -> "80.000 SEK". Currency omitted when unknown. */
export function fmtMoney(n, currency) {
  return currency ? `${fmtAmount(n)} ${currency}` : fmtAmount(n);
}

/** Same as fmtAmount but keeps an explicit sign — for ledger deltas. */
export function fmtSigned(n) {
  const v = Number(n) || 0;
  return `${v >= 0 ? "+" : "−"}${fmtAmount(Math.abs(v))}`;
}

/**
 * "80.000" -> 80000. Strips grouping dots, spaces and non-breaking spaces.
 *
 * Deliberately no decimal handling: every amount in this app is a whole unit of
 * currency, and treating a dot as a decimal point here would turn a typed
 * "80.000" into eighty — which is exactly why these fields cannot be
 * <input type="number"> in the first place.
 */
export function parseAmount(str) {
  if (str == null) return null;
  const digits = String(str).replace(/[^\d-]/g, "");
  if (digits === "" || digits === "-") return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
}
