import { useState, useRef, useEffect } from "react";
import styles from "./LoginPage.module.css";
import enStyles from "./EnrollPage.module.css";

const MEMBERS = [
  { id: "mk", initials: "MK", name: "Magnus Klack",     email: "magnus.klack@anima.se",    bg: "#1e2a2e", col: "#5c9ebe" },
  { id: "tn", initials: "TN", name: "Tommy Norberg",    email: "tommy.norberg@anima.se",   bg: "#2a1e2e", col: "#9e5cbe" },
  { id: "jm", initials: "JM", name: "Johan Molin",      email: "johan.molin@anima.se",     bg: "#1e2818", col: "#6ea86e" },
  { id: "as", initials: "AS", name: "Amber Söderström", email: "amber.soderstrom@anima.se",bg: "#1a2e1a", col: "#5c9e5c" },
  { id: "cb", initials: "CB", name: "Clark Bennet",     email: "clark.bennet@anima.se",    bg: "#2a2318", col: "#b5945a" },
  { id: "dn", initials: "DN", name: "David Norberg",    email: "david.norberg@anima.se",   bg: "#1e1e2e", col: "#7a7abe" },
];

export default function EnrollPage() {
  const params = new URLSearchParams(window.location.search);
  const preselectedId = params.get("user_id");

  const [step, setStep]     = useState(preselectedId ? "loading" : "pick");
  const [user, setUser]     = useState(null);
  const [qr, setQr]         = useState(null);
  const [digits, setDigits] = useState(["","","","","",""]);
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(false);
  const inputs = useRef([]);

  // Auto-start enroll if user_id provided in URL
  useEffect(() => {
    if (!preselectedId) return;
    const member = MEMBERS.find(m => m.id === preselectedId);
    if (member) startEnroll(member);
    else setStep("pick");
  }, []);

  async function startEnroll(member) {
    setUser(member);
    setLoading(true);
    try {
      const res = await fetch("/api/enroll/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: member.id }),
      });
      const data = await res.json();
      setQr(data.qr);
      setStep("qr");
    } catch {
      setError("Could not generate QR code.");
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
        body: JSON.stringify({ user_id: user.id, code }),
      });
      if (!res.ok) throw new Error();
      setStep("done");
    } catch {
      setError("Invalid code. Try again.");
      setDigits(["","","","","",""]);
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

        {step === "pick" && (
          <div className={styles.card}>
            <p className={styles.cardTitle}>Who are you?</p>
            <div className={styles.accountList}>
              {MEMBERS.map(m => (
                <button
                  key={m.id}
                  className={styles.accountRow}
                  onClick={() => startEnroll(m)}
                  disabled={loading}
                >
                  <Avatar initials={m.initials} bg={m.bg} col={m.col} />
                  <div className={styles.accountInfo}>
                    <p className={styles.accountName}>{m.name}</p>
                    <p className={styles.accountEmail}>{m.email}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "qr" && (
          <div className={styles.card}>
            <button className={styles.backBtn} onClick={() => setStep("pick")}>
              <ChevronLeft /> Back
            </button>
            <p className={styles.cardTitle}>Scan with your authenticator app</p>
            <p className={enStyles.qrHint}>
              Open Google Authenticator, Authy, or Apple Passwords and scan this code.
            </p>
            {qr && <img src={qr} alt="TOTP QR code" className={enStyles.qrImage} />}
            <p className={enStyles.qrSub}>Then enter the 6-digit code to confirm.</p>

            <div className={styles.digitRow} style={{ marginTop: "1.25rem" }}>
              {[0,1,2].map(i => (
                <input key={i} ref={el => inputs.current[i] = el}
                  className={styles.digit} maxLength={1} value={digits[i]}
                  onChange={e => handleDigit(e.target.value, i)}
                  onKeyDown={e => handleKeyDown(e, i)} inputMode="numeric" />
              ))}
              <span className={styles.digitSep}>·</span>
              {[3,4,5].map(i => (
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
            <p className={styles.successEmail}>{user.email}</p>
            <p className={styles.successSub} style={{ marginTop: "1.25rem" }}>
              <a href="/login" className={styles.link}>Go to sign in →</a>
            </p>
          </div>
        )}

      </div>
    </div>
  );
}

function Avatar({ initials, bg, col, size = 36 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: bg, color: col,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: Math.floor(size * 0.33), fontWeight: 500,
      flexShrink: 0, fontFamily: "var(--sans)",
    }}>{initials}</div>
  );
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function CheckIconLg() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M5 11l4 4 8-8" stroke="#5c9e5c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
