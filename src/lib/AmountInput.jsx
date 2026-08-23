import { useState, useEffect, useRef } from "react";
import { fmtAmount, parseAmount } from "./money.js";

// ── AmountInput ───────────────────────────────────────────────────────────────
//
// Session 150 — a money field that reads 80.000 while you type it.
//
// These were <input type="number">, which cannot show grouped digits at all: the
// browser only accepts a bare numeric string, and a dot in one is a DECIMAL
// point, so "80.000" would parse as eighty. Showing a salary the way the rest of
// the app prints it therefore requires a text input that formats its own value.
//
// Digits only, regrouped on every keystroke, parsed back to a plain integer on
// commit. inputMode="numeric" still brings up the number pad on a phone.
//
// Commits on blur or Enter rather than per keystroke, matching every other typed
// field here — a half-entered salary should never reach a running actor.
export default function AmountInput({ value, onCommit, style, ...rest }) {
  const [draft, setDraft] = useState(value == null || value === "" ? "" : fmtAmount(value));
  const dirty = useRef(false);

  useEffect(() => {
    if (!dirty.current) setDraft(value == null || value === "" ? "" : fmtAmount(value));
  }, [value]);

  function change(e) {
    dirty.current = true;
    const n = parseAmount(e.target.value);
    setDraft(n == null ? "" : fmtAmount(n));
  }

  function commit() {
    if (!dirty.current) return;
    dirty.current = false;
    const n = parseAmount(draft);
    if (n !== (value == null || value === "" ? null : Number(value))) onCommit(n);
  }

  return (
    <input
      {...rest}
      type="text"
      inputMode="numeric"
      value={draft}
      onChange={change}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { dirty.current = false; setDraft(value == null ? "" : fmtAmount(value)); e.currentTarget.blur(); }
      }}
      style={style}
    />
  );
}
