import { useState, useEffect, useRef } from "react";

const S = {
  page: { minHeight: "100vh", background: "#faf8f5", fontFamily: "DM Sans, system-ui, sans-serif" },
  inner: { maxWidth: 640, margin: "0 auto", padding: "0 20px 60px" },
  topbar: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 0 28px" },
  logo: { fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 18, fontWeight: 500, color: "#1a1814", letterSpacing: ".02em" },
  backBtn: { fontSize: 12, color: "#a8a5a0", background: "none", border: "none", cursor: "pointer", fontFamily: "DM Sans, sans-serif", padding: 0 },
  title: { fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 28, fontWeight: 500, color: "#1a1814", margin: "0 0 4px", letterSpacing: ".01em" },
  subtitle: { fontSize: 12, color: "#a8a5a0", margin: "0 0 28px" },
  empty: { fontSize: 13, color: "#c0bdb8", textAlign: "center", padding: "60px 0" },
  card: { background: "#fff", borderRadius: 12, border: "1px solid #ede9e3", marginBottom: 10, overflow: "hidden" },
  cardHeader: { display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", cursor: "pointer" },
  avatar: (col) => ({ width: 36, height: 36, borderRadius: "50%", background: col.bg, color: col.col, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, flexShrink: 0 }),
  cardMeta: { flex: 1, minWidth: 0 },
  senderName: { fontSize: 14, fontWeight: 500, color: "#1a1814", marginBottom: 2 },
  timestamp: { fontSize: 11, color: "#a8a5a0" },
  unreadDot: { width: 7, height: 7, borderRadius: "50%", background: "#b05c08", flexShrink: 0 },
  chevron: (open) => ({ transition: "transform .2s", transform: open ? "rotate(180deg)" : "none", color: "#c0bdb8", flexShrink: 0 }),
  body: { padding: "0 16px 16px", borderTop: "1px solid #f5f2ee" },
  transcript: { fontSize: 13, color: "#4a4744", lineHeight: 1.6, padding: "14px 0 12px" },
  playerRow: { display: "flex", alignItems: "center", gap: 10 },
  playBtn: { width: 34, height: 34, borderRadius: "50%", background: "#b05c08", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background .15s" },
  progress: { flex: 1, height: 3, background: "#ede9e3", borderRadius: 2, cursor: "pointer", overflow: "hidden" },
  progressFill: (pct) => ({ height: "100%", width: `${pct}%`, background: "#b05c08", borderRadius: 2, transition: "width .1s linear" }),
  duration: { fontSize: 11, color: "#a8a5a0", minWidth: 32, textAlign: "right" },
  fallbackNote: { fontSize: 11, color: "#c0bdb8", marginTop: 8, fontStyle: "italic" },
};

const AVATAR_COLORS = {
  "amber-soderstrom-actor":  { bg: "#1a2a1e", col: "#6db87c" },
  "clark-bennet-actor":      { bg: "#2a2318", col: "#b5945a" },
  "tommy-norberg-actor":     { bg: "#2a1e2e", col: "#9e5cbe" },
  "johan-molin-actor":       { bg: "#1e2818", col: "#6ea86e" },
  "david-norberg-actor":     { bg: "#1e1e2e", col: "#7a7abe" },
};

function initials(name) {
  return (name || "?").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();
}

function avatarColor(id) {
  return AVATAR_COLORS[id] || { bg: "#2a2218", col: "#b09070" };
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString("en-SE", { month: "short", day: "numeric" });
}

function VoicemailCard({ msg, worldId, actorId, apiFetch }) {
  const [open, setOpen]         = useState(false);
  const [playing, setPlaying]   = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading]   = useState(false);
  const [fallback, setFallback] = useState(false);
  const audioRef = useRef(null);
  const col = avatarColor(msg.sender_id);

  async function playAudio() {
    if (fallback) return;
    if (audioRef.current) {
      if (playing) { audioRef.current.pause(); setPlaying(false); return; }
      audioRef.current.play(); setPlaying(true); return;
    }
    setLoading(true);
    try {
      const res = await apiFetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: msg.content, actor_id: msg.sender_id })
      });
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("audio")) {
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.addEventListener("timeupdate", () => {
          setProgress(audio.duration ? (audio.currentTime / audio.duration) * 100 : 0);
          setDuration(audio.duration || 0);
        });
        audio.addEventListener("ended", () => { setPlaying(false); setProgress(0); });
        audio.addEventListener("loadedmetadata", () => setDuration(audio.duration));
        audio.play();
        setPlaying(true);
      } else {
        setFallback(true);
      }
    } catch {
      setFallback(true);
    } finally {
      setLoading(false);
    }
  }

  function seekTo(e) {
    if (!audioRef.current || !audioRef.current.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = pct * audioRef.current.duration;
  }

  return (
    <div style={S.card}>
      <div style={S.cardHeader} onClick={() => setOpen(o => !o)}>
        <div style={S.avatar(col)}>{initials(msg.sender_name)}</div>
        <div style={S.cardMeta}>
          <div style={S.senderName}>{msg.sender_name}</div>
          <div style={S.timestamp}>{formatDate(msg.sent_at)}</div>
        </div>
        {!msg.read_at && <div style={S.unreadDot} />}
        <svg style={S.chevron(open)} width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {open && (
        <div style={S.body}>
          <p style={S.transcript}>{msg.content}</p>

          {!fallback && (
            <div style={S.playerRow}>
              <button style={S.playBtn} onClick={playAudio} disabled={loading}>
                {loading ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <circle cx="6" cy="6" r="4" stroke="#fff" strokeWidth="1.5" strokeDasharray="6 6">
                      <animateTransform attributeName="transform" type="rotate" from="0 6 6" to="360 6 6" dur=".8s" repeatCount="indefinite"/>
                    </circle>
                  </svg>
                ) : playing ? (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <rect x="2" y="2" width="3" height="8" rx="1" fill="#fff"/>
                    <rect x="7" y="2" width="3" height="8" rx="1" fill="#fff"/>
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path d="M3 2l7 4-7 4V2z" fill="#fff"/>
                  </svg>
                )}
              </button>
              <div style={S.progress} onClick={seekTo}>
                <div style={S.progressFill(progress)} />
              </div>
              <span style={S.duration}>{duration > 0 ? formatTime(duration) : "—"}</span>
            </div>
          )}

          {fallback && (
            <p style={S.fallbackNote}>Voice server offline — transcript above</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function VoicemailPage() {
  const params  = new URLSearchParams(window.location.search);
  const appId   = params.get("app");

  const apiKeyRef = useRef(null);
  function apiFetch(url, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (apiKeyRef.current) headers["x-api-key"] = apiKeyRef.current;
    return fetch(url, { ...opts, headers });
  }
  function resolveWorldKey(worldId) {
    const stored = localStorage.getItem(`anima_world_key_${worldId}`);
    if (stored) { apiKeyRef.current = stored; return; }
    fetch(`/api/worlds/${worldId}/issue-key`, { method: "POST" })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.key) {
          localStorage.setItem(`anima_world_key_${worldId}`, data.key);
          apiKeyRef.current = data.key;
        }
      });
  }

  const [messages, setMessages] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [appName, setAppName]   = useState("Voicemail");
  const [worldId, setWorldId]   = useState(null);
  const [actorId, setActorId]   = useState(null);

  useEffect(() => {
    apiFetch("/api/me")
      .then(r => r.ok ? r.json() : null)
      .then(me => {
        if (!me) { window.location.href = "/login"; return; }
        if (appId) {
          apiFetch("/api/apps")
            .then(r => r.ok ? r.json() : [])
            .then(apps => {
              const app = apps.find(a => a.id === appId);
              const src = app || me.worlds?.[0];
              if (!src) return;
              if (app?.name) { setAppName(app.name); document.title = app.name; }
              resolveWorldKey(src.world_id);
              setWorldId(src.world_id);
              setActorId(src.actor_id);
              apiFetch(`/api/worlds/${src.world_id}/actors/${src.actor_id}/voicemail`)
                .then(r => r.ok ? r.json() : [])
                .then(data => { setMessages(data); setLoading(false); })
                .catch(() => setLoading(false));
            });
        } else {
          const world = me.worlds?.[0];
          if (!world) return;
          resolveWorldKey(world.world_id);
          setWorldId(world.world_id);
          setActorId(world.actor_id);
          apiFetch(`/api/worlds/${world.world_id}/actors/${world.actor_id}/voicemail`)
            .then(r => r.ok ? r.json() : [])
            .then(data => { setMessages(data); setLoading(false); })
            .catch(() => setLoading(false));
        }
      });
  }, []);

  const unread = messages.filter(m => !m.read_at).length;

  return (
    <div style={S.page}>
      <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet" />
      <div style={S.inner}>
        <div style={S.topbar}>
          <span style={S.logo}>Anima</span>
          <button style={S.backBtn} onClick={() => history.back()}>← Back</button>
        </div>

        <p style={S.title}>{appName}</p>
        <p style={S.subtitle}>
          {loading ? "Loading…" : messages.length === 0 ? "No voice messages" : `${messages.length} message${messages.length !== 1 ? "s" : ""}${unread > 0 ? ` · ${unread} new` : ""}`}
        </p>

        {!loading && messages.length === 0 && (
          <p style={S.empty}>No voice messages yet.</p>
        )}

        {messages.map(msg => (
          <VoicemailCard
            key={msg.id}
            msg={msg}
            worldId={worldId}
            actorId={actorId}
            apiFetch={apiFetch}
          />
        ))}
      </div>
    </div>
  );
}
