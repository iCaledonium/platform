import { useState, useRef, useEffect } from "react";
import styles from "./LoginPage.module.css";
import enStyles from "./EnrollPage.module.css";

// Enrolment is reached one of two ways, and never by naming a user:
//
//   /enroll?token=<invite>   a new account, from the link an admin handed over
//   /enroll                  you, already signed in, moving to a new phone
//
// The page used to carry a hardcoded roster and enrol whoever you clicked. That
// list was not a convenience, it was the attack: this page is public, and the
// old /api/enroll/start took the id at face value. Both halves are gone — the
// server now requires the token or a session, and there is nothing here to pick.
export default function EnrollPage() {
  const token = new URLSearchParams(window.location.search).get("token");

  const [step, setStep]       = useState("loading");
  const [user, setUser]       = useState(null);
  const [qr, setQr]           = useState(null);
  const [digits, setDigits]   = useState(["", "", "", "", "", ""]);
  const [error, setError]     = useState(null);
  const [fatal, setFatal]     = useState(null);
  const [loading, setLoading] = useState(false);
  const inputs = useRef([]);

  useEffect(() => { startEnroll(); }, []);

  async function startEnroll() {
    setLoading(true);
    try {
      const res = await fetch("/api/enroll/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(token ? { token } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFatal(data.error || "This enrolment link is not valid.");
        setStep("blocked");
        return;
      }
      setUser({ name: data.name, email: data.email });
      setQr(data.qr);
      setStep("qr");
    } catch {
      setFatal("Could not reach the server.");
      setStep("blocked");
    } finally {
      setLoading(false);
    }
  }

  function handleDigit(val, idx) {
    if (!/^\d?$/.test(val)) return;
    const next = [...digits];
    next[idx] = val;
    setDigits(next);
    setError(null);
    if (val && idx < 5) inputs.current[idx + 1]?.focus();
    if (val && idx === 5) {
      const code = next.join("");
      if (code.length === 6) confirmEnroll(code);
    }
  }

  function handleKeyDown(e, idx) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0)
      inputs.current[idx - 1]?.focus();
  }

  async function confirmEnroll(code) {
    setLoading(true);
    try {
      const res = await fetch("/api/enroll/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(token ? { token, code } : { code }),
      });
      if (!res.ok) throw new Error();
      setStep("done");
    } catch {
      setError("Invalid code. Try again.");
      setDigits(["", "", "", "", "", ""]);
      inputs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>

        <div className={styles.wordmark}>
          <span className={styles.logo}>Anima</span>
          <span className={styles.tagline}>Authenticator setup</span>
        </div>

        {step === "loading" && (
          <div className={styles.card} style={{ textAlign: "center", padding: "2rem" }}>
            <p style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--text-3)" }}>Setting up…</p>
          </div>
        )}

        {step === "blocked" && (
          <div className={styles.card} style={{ textAlign: "center" }}>
            <p className={styles.cardTitle}>Can't set up here</p>
            <p style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--text-3)", lineHeight: 1.55, margin: "0 0 1rem" }}>
              {fatal}
            </p>
            <p style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-3)", lineHeight: 1.55 }}>
              Setting up an authenticator needs a current invite link, or a signed-in
              session if you are moving to a new phone.
            </p>
            <div className={styles.divider} />
            <a href="/login" className={styles.link} style={{ fontFamily: "var(--sans)", fontSize: 13 }}>
              Go to sign in →
            </a>
          </div>
        )}

        {step === "qr" && (
          <div className={styles.card}>
            <p className={styles.cardTitle}>Scan with your authenticator app</p>
            {user?.email && (
              <p style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-3)", margin: "0 0 .75rem" }}>
                Setting up <strong style={{ color: "var(--text-2)" }}>{user.email}</strong>
              </p>
            )}
            <p className={enStyles.qrHint}>
              Open Google Authenticator, Authy, or Apple Passwords and scan this code.
            </p>
            {qr && <img src={qr} alt="TOTP QR code" className={enStyles.qrImage} />}
            <p className={enStyles.qrSub}>Then enter the 6-digit code to confirm.</p>

            <div className={styles.digitRow} style={{ marginTop: "1.25rem" }}>
              {[0, 1, 2].map(i => (
                <input key={i} ref={el => inputs.current[i] = el}
                  className={styles.digit} maxLength={1} value={digits[i]}
                  onChange={e => handleDigit(e.target.value, i)}
                  onKeyDown={e => handleKeyDown(e, i)} inputMode="numeric" />
              ))}
              <span className={styles.digitSep}>·</span>
              {[3, 4, 5].map(i => (
                <input key={i} ref={el => inputs.current[i] = el}
                  className={styles.digit} maxLength={1} value={digits[i]}
                  onChange={e => handleDigit(e.target.value, i)}
                  onKeyDown={e => handleKeyDown(e, i)} inputMode="numeric" />
              ))}
            </div>

            {error && <p className={styles.errorMsg}>{error}</p>}

            <button
              className={styles.primaryBtn}
              style={{ marginTop: "1rem" }}
              disabled={digits.join("").length < 6 || loading}
              onClick={() => confirmEnroll(digits.join(""))}
            >
              {loading ? "Confirming…" : "Confirm & enroll"}
            </button>
          </div>
        )}

        {step === "done" && (
          <div className={`${styles.card} ${styles.cardCenter}`}>
            <div className={styles.successIcon}>
              <CheckIconLg />
            </div>
            <p className={styles.successHeading}>You're enrolled.</p>
            <p className={styles.successEmail}>{user?.email}</p>
            <p className={styles.successSub} style={{ marginTop: "1.25rem" }}>
              <a href="/login" className={styles.link}>Go to sign in →</a>
            </p>
          </div>
        )}

      </div>
    </div>
  );
}

function CheckIconLg() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M5 11l4 4 8-8" stroke="#5c9e5c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
