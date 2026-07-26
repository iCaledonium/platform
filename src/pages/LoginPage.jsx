import { useState, useRef, useEffect } from "react";
import styles from "./LoginPage.module.css";

// ── Step components ──────────────────────────────────────────────────────────

function OrgPicker({ onSelect }) {
  return (
    <div className={styles.card}>
      <p className={styles.cardTitle}>Sign in to</p>

      <button className={styles.orgTile} onClick={() => onSelect("anima")}>
        <div className={styles.orgIcon} style={{ background: "#1e2030", color: "#8fa8d8" }}>
          <LockIcon />
        </div>
        <div className={styles.orgInfo}>
          <p className={styles.orgName}>Anima Systems AB</p>
          <p className={styles.orgMeta}>Organization · staff access</p>
        </div>
        <span className={`${styles.badge} ${styles.badgeActive}`}>active</span>
      </button>

      <button className={`${styles.orgTile} ${styles.orgTileDim}`} disabled>
        <div className={styles.orgIcon} style={{ background: "#1a1813", color: "#4a4540" }}>
          <PersonIcon />
        </div>
        <div className={styles.orgInfo}>
          <p className={styles.orgName} style={{ color: "#4a4540" }}>Personal</p>
          <p className={styles.orgMeta}>Consumer · private worlds</p>
        </div>
        <span className={`${styles.badge} ${styles.badgeSoon}`}>soon</span>
      </button>

      <p className={styles.hint}>
        New to Anima? <a href="mailto:hello@animasystems.se" className={styles.link}>Request access</a>
      </p>
    </div>
  );
}

function AccountPicker({ org, onSelect, onBack }) {
  const [selected, setSelected] = useState(null);
  const [members, setMembers] = useState([]);
  const [fetchError, setFetchError] = useState(false);

  function loadMembers() {
    setFetchError(false);
    fetch(`/api/orgs/${org}/members`)
      .then(r => r.json())
      .then(data => setMembers(data))
      .catch(() => setFetchError(true));
  }

  useEffect(() => { loadMembers(); }, [org]);

  function handleNext() {
    if (selected === null) return;
    const m = members[selected];
    if (!m.enrolled) {
      window.location.href = `/enroll?user_id=${m.id}`;
      return;
    }
    onSelect(m);
  }

  return (
    <div className={styles.card}>
      <button className={styles.backBtn} onClick={onBack}>
        <ChevronLeft /> Anima Systems AB
      </button>
      <p className={styles.cardTitle}>Choose your account</p>

      <div className={styles.accountList}>
        {fetchError && (
          <div style={{ textAlign: "center", padding: "1rem 0" }}>
            <p style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-3)", marginBottom: 8 }}>Could not load accounts.</p>
            <button className={styles.backBtn} style={{ margin: "0 auto" }} onClick={loadMembers}>Retry</button>
          </div>
        )}
        {members.map((m, idx) => (
          <button
            key={m.id}
            className={`${styles.accountRow} ${selected === idx ? styles.accountRowSel : ""}`}
            onClick={() => setSelected(idx)}
          >
            <Avatar initials={m.initials || m.name.split(" ").map(n=>n[0]).join("").slice(0,2)}
                    bg={AVATARS[m.id]?.bg || "#1e2a2e"}
                    col={AVATARS[m.id]?.col || "#5c9ebe"} />
            <div className={styles.accountInfo}>
              <p className={styles.accountName}>{m.name}</p>
              <p className={styles.accountEmail}>{m.email}</p>
            </div>
            {!m.enrolled && (
              <span style={{ fontSize: 10, color: "#b05c08", border: "1px solid rgba(176,92,8,.2)", borderRadius: 4, padding: "2px 7px", letterSpacing: "0.06em", textTransform: "uppercase", flexShrink: 0 }}>
                setup required
              </span>
            )}
            <div className={`${styles.check} ${selected === idx ? styles.checkOn : ""}`}>
              {selected === idx && <CheckIcon />}
            </div>
          </button>
        ))}
      </div>

      <div className={styles.divider} />
      <button className={styles.primaryBtn} disabled={selected === null} onClick={handleNext}>
        Next →
      </button>
    </div>
  );
}

function TOTPInput({ user, onBack, onVerify }) {
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const inputs = useRef([]);

  function handleChange(val, idx) {
    if (!/^\d?$/.test(val)) return;
    const next = [...digits];
    next[idx] = val;
    setDigits(next);
    setError(null);
    if (val && idx < 5) inputs.current[idx + 1]?.focus();
    if (val && idx === 5) {
      const code = [...next.slice(0, 3), ...next.slice(3)].join("");
      if (code.length === 6) submitCode(code);
    }
  }

  function handleKeyDown(e, idx) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) {
      inputs.current[idx - 1]?.focus();
    }
  }

  async function submitCode(code) {
    setLoading(true);
    try {
      // POST /api/auth/verify  { user_id, code }
      await onVerify(user.id, code);
    } catch (err) {
      setError("Invalid code. Try again.");
      setDigits(["", "", "", "", "", ""]);
      inputs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  }

  function handleVerify() {
    const code = digits.join("");
    if (code.length === 6) submitCode(code);
  }

  return (
    <div className={styles.card}>
      <button className={styles.backBtn} onClick={onBack}>
        <ChevronLeft /> Back
      </button>

      <div className={styles.totpUser}>
        <Avatar initials={user.initials} bg={user.bg} col={user.col} size={42} />
        <div>
          <p className={styles.accountName}>{user.name}</p>
          <p className={styles.accountEmail}>{user.email}</p>
        </div>
      </div>

      <p className={styles.totpHint}>
        Enter the 6-digit code from your authenticator app.
      </p>

      <div className={styles.digitRow}>
        {[0, 1, 2].map(i => (
          <input
            key={i}
            ref={el => inputs.current[i] = el}
            className={styles.digit}
            maxLength={1}
            value={digits[i]}
            onChange={e => handleChange(e.target.value, i)}
            onKeyDown={e => handleKeyDown(e, i)}
            inputMode="numeric"
          />
        ))}
        <span className={styles.digitSep}>·</span>
        {[3, 4, 5].map(i => (
          <input
            key={i}
            ref={el => inputs.current[i] = el}
            className={styles.digit}
            maxLength={1}
            value={digits[i]}
            onChange={e => handleChange(e.target.value, i)}
            onKeyDown={e => handleKeyDown(e, i)}
            inputMode="numeric"
          />
        ))}
      </div>

      {error && <p className={styles.errorMsg}>{error}</p>}

      <button
        className={styles.primaryBtn}
        disabled={digits.join("").length < 6 || loading}
        onClick={handleVerify}
      >
        {loading ? "Verifying…" : "Verify & enter"}
      </button>
    </div>
  );
}

function Success({ user }) {
  return (
    <div className={`${styles.card} ${styles.cardCenter}`}>
      <div className={styles.successIcon}>
        <CheckIconLg />
      </div>
      <p className={styles.successHeading}>Welcome back.</p>
      <p className={styles.successEmail}>{user.email}</p>
      <p className={styles.successSub}>Entering Stockholm…</p>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const [step, setStep] = useState("org");       // org | accounts | totp | success
  const [org, setOrg] = useState(null);
  const [user, setUser] = useState(null);

  async function handleVerify(userId, code) {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, code }),
    });
    if (!res.ok) throw new Error("Invalid code");
    // cookie set by server
    setStep("success");
    setTimeout(() => {
      window.location.href = "/home";
    }, 1400);
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>

        <div className={styles.wordmark}>
          <span className={styles.logo}>Anima</span>
          <span className={styles.tagline}>We Deliver Worlds</span>
        </div>

        {step === "org" && (
          <OrgPicker onSelect={id => { setOrg(id); setStep("accounts"); }} />
        )}
        {step === "accounts" && (
          <AccountPicker
            org={org}
            onSelect={u => { setUser(u); setStep("totp"); }}
            onBack={() => setStep("org")}
          />
        )}
        {step === "totp" && (
          <TOTPInput
            user={user}
            onBack={() => setStep("accounts")}
            onVerify={handleVerify}
          />
        )}
        {step === "success" && (
          <Success user={user} />
        )}

        <p className={styles.footer}>Plans meet psychology. Sometimes psychology wins.</p>
      </div>
    </div>
  );
}

// Avatar colours keyed by user id — purely visual, not auth data
const AVATARS = {
  mk: { bg: "#1e2a2e", col: "#5c9ebe" },
  tn: { bg: "#2a1e2e", col: "#9e5cbe" },
  jm: { bg: "#1e2818", col: "#6ea86e" },
  as: { bg: "#1a2e1a", col: "#5c9e5c" },
  cb: { bg: "#2a2318", col: "#b5945a" },
  dn: { bg: "#1e1e2e", col: "#7a7abe" },
};

// ── Small components ─────────────────────────────────────────────────────────

function Avatar({ initials, bg, col, size = 36 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: "50%",
      background: bg, color: col,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: Math.floor(size * 0.33), fontWeight: 500,
      flexShrink: 0, fontFamily: "var(--sans)",
    }}>
      {initials}
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2" y="7" width="14" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
      <path d="M6 7V5a3 3 0 016 0v2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="9" cy="12" r="1.2" fill="currentColor" />
    </svg>
  );
}

function PersonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="6.5" r="3" stroke="currentColor" strokeWidth="1.1" />
      <path d="M3 15c0-3.314 2.686-5 6-5s6 1.686 6 5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M9 2L4 7l5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 5l2.5 2.5 3.5-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIconLg() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
      <path d="M5 11l4 4 8-8" stroke="#5c9e5c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
