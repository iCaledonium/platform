import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import styles from "./LoginPage.module.css";
import ivStyles from "./InvitePage.module.css";

// What a new person sees first: the account someone made for them, their own
// name to correct if it was typed wrong, and one button through to the
// authenticator. The token in the URL is the whole of their authority here —
// it expires, it is single-use, and it dies the moment they finish enrolling.
export default function InvitePage() {
  const { token } = useParams();

  const [state, setState]     = useState("loading"); // loading | form | invalid
  const [email, setEmail]     = useState("");
  const [name, setName]       = useState("");
  const [error, setError]     = useState(null);
  const [fatal, setFatal]     = useState(null);
  const [saving, setSaving]   = useState(false);

  useEffect(() => {
    fetch(`/api/invite/${token}`)
      .then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "This invite is not valid.");
        setName(data.name || "");
        setEmail(data.email || "");
        setState("form");
      })
      .catch(e => { setFatal(e.message); setState("invalid"); });
  }, [token]);

  async function handleContinue() {
    const trimmed = name.trim();
    if (!trimmed) { setError("Please enter your name."); return; }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/invite/${token}/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not save your details.");
      // Straight on to the authenticator, carrying the same token: the invite is
      // not spent until a code has actually been confirmed, so a reload here
      // costs nothing.
      window.location.href = `/enroll?token=${encodeURIComponent(token)}`;
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.inner}>

        <div className={styles.wordmark}>
          <span className={styles.logo}>Anima</span>
          <span className={styles.tagline}>Create your account</span>
        </div>

        {state === "loading" && (
          <div className={styles.card} style={{ textAlign: "center", padding: "2rem" }}>
            <p style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--text-3)" }}>Checking your invite…</p>
          </div>
        )}

        {state === "invalid" && (
          <div className={styles.card} style={{ textAlign: "center" }}>
            <p className={styles.cardTitle}>Invite not valid</p>
            <p className={ivStyles.intro} style={{ marginBottom: "1rem" }}>{fatal}</p>
            <p className={ivStyles.intro}>
              Invite links last seven days and can only be used once. Ask whoever
              invited you to send a fresh one.
            </p>
            <div className={styles.divider} />
            <a href="/login" className={styles.link} style={{ fontFamily: "var(--sans)", fontSize: 13 }}>
              Go to sign in →
            </a>
          </div>
        )}

        {state === "form" && (
          <div className={styles.card}>
            <p className={styles.cardTitle}>Confirm your details</p>
            <p className={ivStyles.intro}>
              An account has been created for you at Anima Systems. Check your name
              is right, then set up an authenticator app to finish.
            </p>

            <div className={ivStyles.field}>
              <label className={ivStyles.fieldLabel} htmlFor="invite-name">Your name</label>
              <input
                id="invite-name"
                className={ivStyles.input}
                value={name}
                onChange={e => { setName(e.target.value); setError(null); }}
                onKeyDown={e => { if (e.key === "Enter") handleContinue(); }}
                autoFocus
              />
            </div>

            <div className={ivStyles.field}>
              <label className={ivStyles.fieldLabel}>Email</label>
              <div className={ivStyles.readonly}>{email}</div>
            </div>

            {error && <p className={styles.errorMsg}>{error}</p>}

            <div className={styles.divider} />
            <button className={styles.primaryBtn} disabled={saving} onClick={handleContinue}>
              {saving ? "Saving…" : "Continue → set up authenticator"}
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
