import { useState, useRef, useEffect } from "react";
import styles from "./LoginPage.module.css";
import ivStyles from "./InvitePage.module.css";   // shared field/label styling

// ── Step components ──────────────────────────────────────────────────────────

// The company tiles come from /api/orgs now, not from a constant. Personal
// accounts are deliberately NOT among them: each one is an org of exactly one
// person, and listing those here would publish the existence of every private
// account on a page anybody can open. They sign in by email instead — the one
// tile that asks who you are rather than letting you point at yourself.
function OrgPicker({ onSelect, onPersonal }) {
  const [orgs, setOrgs] = useState([]);

  useEffect(() => {
    fetch("/api/orgs").then(r => r.ok ? r.json() : []).then(setOrgs).catch(() => setOrgs([]));
  }, []);

  return (
    <div className={styles.card}>
      <p className={styles.cardTitle}>Sign in to</p>

      {orgs.map(o => (
        <button key={o.id} className={styles.orgTile} onClick={() => onSelect(o.id)}>
          <div className={styles.orgIcon} style={{ background: "#1e2030", color: "#8fa8d8" }}>
            <LockIcon />
          </div>
          <div className={styles.orgInfo}>
            <p className={styles.orgName}>{o.name}</p>
            <p className={styles.orgMeta}>Organization · staff access</p>
          </div>
          <span className={`${styles.badge} ${styles.badgeActive}`}>active</span>
        </button>
      ))}

      <button className={styles.orgTile} onClick={onPersonal}>
        <div className={styles.orgIcon} style={{ background: "#1e2030", color: "#8fa8d8" }}>
          <PersonIcon />
        </div>
        <div className={styles.orgInfo}>
          <p className={styles.orgName}>Personal</p>
          <p className={styles.orgMeta}>Private account · sign in with email</p>
        </div>
        <span className={`${styles.badge} ${styles.badgeActive}`}>active</span>
      </button>

      <p className={styles.hint}>
        New to Anima? <a href="mailto:hello@animasystems.se" className={styles.link}>Request access</a>
      </p>
    </div>
  );
}

// A private person is not on a list, so this asks for the address and the code
// together. The server answers one identical 401 for an unknown address, an
// un-enrolled account and a wrong code — the form must not become a way to test
// whether somebody has an Anima account.
function PersonalSignIn({ onBack, onVerify }) {
  const [email, setEmail]   = useState("");
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [error, setError]   = useState(null);
  const [loading, setLoading] = useState(false);
  const inputs = useRef([]);

  const code = digits.join("");
  const ready = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && code.length === 6;

  function handleChange(val, idx) {
    if (!/^\d?$/.test(val)) return;
    const next = [...digits];
    next[idx] = val;
    setDigits(next);
    setError(null);
    if (val && idx < 5) inputs.current[idx + 1]?.focus();
  }

  function handleKeyDown(e, idx) {
    if (e.key === "Backspace" && !digits[idx] && idx > 0) inputs.current[idx - 1]?.focus();
  }

  async function submit() {
    if (!ready) return;
    setLoading(true);
    try {
      await onVerify({ email: email.trim().toLowerCase() }, code);
    } catch {
      setError("That email and code did not match.");
      setDigits(["", "", "", "", "", ""]);
      inputs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.card}>
      <button className={styles.backBtn} onClick={onBack}>
        <ChevronLeft /> Back
      </button>
      <p className={styles.cardTitle}>Personal account</p>

      <div style={{ marginBottom: "1rem" }}>
        <label className={ivStyles.fieldLabel} htmlFor="personal-email">Email</label>
        <input
          id="personal-email"
          className={ivStyles.input}
          type="email"
          value={email}
          autoFocus
          placeholder="you@example.com"
          onChange={e => { setEmail(e.target.value); setError(null); }}
        />
      </div>

      <p className={styles.totpHint}>
        Enter the 6-digit code from your authenticator app.
      </p>

      <div className={styles.digitRow}>
        {[0, 1, 2].map(i => (
          <input key={i} ref={el => inputs.current[i] = el} className={styles.digit}
                 maxLength={1} value={digits[i]} inputMode="numeric"
                 onChange={e => handleChange(e.target.value, i)}
                 onKeyDown={e => handleKeyDown(e, i)} />
        ))}
        <span className={styles.digitSep}>·</span>
        {[3, 4, 5].map(i => (
          <input key={i} ref={el => inputs.current[i] = el} className={styles.digit}
                 maxLength={1} value={digits[i]} inputMode="numeric"
                 onChange={e => handleChange(e.target.value, i)}
                 onKeyDown={e => handleKeyDown(e, i)} />
        ))}
      </div>

      {error && <p className={styles.errorMsg}>{error}</p>}

      <button className={styles.primaryBtn} disabled={!ready || loading} onClick={submit}>
        {loading ? "Verifying…" : "Verify & enter"}
      </button>
    </div>
  );
}

function AccountPicker({ org, onSelect, onBack }) {
  const [selected, setSelected] = useState(null);
  const [members, setMembers] = useState([]);
  const [fetchError, setFetchError] = useState(false);
  const [notice, setNotice] = useState(null);

  function loadMembers() {
    setFetchError(false);
    // /api/orgs/:org/members answers 404 for an unknown org now that :org means
    // something. Without the ok check the error body lands in `members` and the
    // .map below throws — a blank sign-in page instead of a "could not load".
    fetch(`/api/orgs/${org}/members`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error("not ok")))
      .then(data => setMembers(Array.isArray(data) ? data : []))
      .catch(() => setFetchError(true));
  }

  useEffect(() => { loadMembers(); }, [org]);

  // An account without an authenticator is not a door this page can open. It
  // used to send you to /enroll?user_id=<them>, which enrolled whoever you had
  // clicked — on a page that lists everybody and needs no login. Setting up a
  // second factor now takes an invite link, and only someone who already has an
  // account can issue one.
  function handleNext() {
    if (selected === null) return;
    const m = members[selected];
    if (!m.enrolled) {
      setNotice(`${m.name.split(" ")[0]}'s account hasn't been set up yet. Ask a colleague to send an invite link from People.`);
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
            onClick={() => { setSelected(idx); setNotice(null); }}
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

      {notice && <p className={styles.errorMsg}>{notice}</p>}

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
      await onVerify({ user_id: user.id }, code);
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

function Success({ user, handedOver, handoffUrl }) {
  return (
    <div className={`${styles.card} ${styles.cardCenter}`}>
      <div className={styles.successIcon}>
        <CheckIconLg />
      </div>
      <p className={styles.successHeading}>Welcome back.</p>
      <p className={styles.successEmail}>{user.email}</p>
      <p className={styles.successSub}>
        {handedOver ? "Opening Anima…" : "Entering Stockholm…"}
      </p>
      {/* The one thing a handover must never do is strand someone who does not
          have the app: anima:// simply does nothing for them, and a page that
          then walks away on its own is a dead end. So the way back is always
          on screen. */}
      {/* No button. The app opens by itself — and if it is already running,
          the running instance takes the session rather than a second window
          being made for it. The only thing offered here is the way out for
          someone who has no app installed. */}
      {handedOver && (
        <a href="/home" className={styles.successSub}
           style={{ marginTop: 14, display: "inline-block", textDecoration: "underline",
                    cursor: "pointer", opacity: .55, fontSize: 12 }}>
          Continue in this browser instead
        </a>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

// Inside the desktop app, this page is not a form.
//
// Identity lives in the browser — one password path, one 2FA path, one revoke
// button — so an app that grew its own login screen would quietly undo the
// reason for the handover. Whenever the app finds itself without a session
// (signed out, expired, first launch) it points at the browser instead, and the
// browser hands a fresh session straight back through anima://.
//
// window.open is routed to the real browser by the shell's
// setWindowOpenHandler; in an ordinary browser this component never renders.
function DesktopSignIn() {
  const open = () => window.open(`${window.location.origin}/login`, "_blank");
  return (
    <div className={`${styles.card} ${styles.cardCenter}`}>
      <p className={styles.successHeading}>Signed out.</p>
      <p className={styles.successSub} style={{ marginTop: 8, maxWidth: 300 }}>
        Signing in happens in your browser. Anima opens again by itself once
        you are done.
      </p>
      <button className={styles.primaryBtn} onClick={open} style={{ marginTop: 20 }}>
        Sign in with your browser →
      </button>
    </div>
  );
}

export default function LoginPage() {
  const inDesktopApp = typeof navigator !== "undefined" && /(^|\s)Anima\//.test(navigator.userAgent);
  const [step, setStep] = useState("org");       // org | accounts | personal | totp | success
  const [org, setOrg] = useState(null);
  const [user, setUser] = useState(null);
  const [handedOver, setHandedOver] = useState(false);
  const [handoffUrl, setHandoffUrl] = useState(null);

  // Session 153 — the browser's job ends the moment you are authenticated.
  //
  // Sign in, pick the organisation, pick the account, enter the code — and then
  // the browser hands the session to the desktop app and steps back out to the
  // landing page. It is the Slack/Zoom/Docker shape, and it is the right one:
  // identity lives in exactly one place (password, 2FA, revocation) and the app
  // never carries a login screen of its own.
  //
  // The ticket is single-use and dead in sixty seconds, so it is safe in a URL.
  // `credential` is { user_id } for an org member picked off a list, or
  // { email } for a private account that is on no list at all.
  async function handleVerify(credential, code) {
    const res = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...credential, code }),
    });
    if (!res.ok) throw new Error("Invalid code");
    if (credential.email && !user) setUser({ email: credential.email });
    const body = await res.json().catch(() => ({}));   // carries the handoff url
    // cookie set by server
    setStep("success");

    // Signing in from inside the app itself: there is nothing to hand over to.
    if (/(^|\s)Anima\//.test(navigator.userAgent)) {
      setTimeout(() => { window.location.href = "/home"; }, 1400);
      return;
    }

    if (body.handoff) {
      setHandoffUrl(body.handoff);
      setHandedOver(true);
      // Immediately, off the back of the click that submitted the code — no
      // second round-trip in between, because that is the thing most likely to
      // cost us the activation the launch depends on.
      window.location.href = body.handoff;
      // Then the browser leaves the way it came in.
      setTimeout(() => { window.location.href = "/"; }, 4000);
      return;
    }

    setTimeout(() => { window.location.href = "/home"; }, 1400);
  }

  if (inDesktopApp && step !== "success") {
    return (
      <div className={styles.page}>
        <div className={styles.inner}>
          <div className={styles.wordmark}>
            <span className={styles.logo}>Anima</span>
            <span className={styles.tagline}>We Deliver Worlds</span>
          </div>
          <DesktopSignIn />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>

        <div className={styles.wordmark}>
          <span className={styles.logo}>Anima</span>
          <span className={styles.tagline}>We Deliver Worlds</span>
        </div>

        {step === "org" && (
          <OrgPicker
            onSelect={id => { setOrg(id); setStep("accounts"); }}
            onPersonal={() => { setOrg(null); setStep("personal"); }}
          />
        )}
        {step === "personal" && (
          <PersonalSignIn onBack={() => setStep("org")} onVerify={handleVerify} />
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
          <Success user={user} handedOver={handedOver} handoffUrl={handoffUrl} />
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
