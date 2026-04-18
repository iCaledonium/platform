import { useState, useEffect } from "react";
import homeStyles from "./HomePage.module.css";
import AppWizard from "./AppWizard.jsx";
import AppConfig from "./AppConfig.jsx";

const WORLD_ID   = "e7368020-fc19-4914-95ac-2f7c5508a13c";
const WORLD_NAME = "Anima — Stockholm";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

const TOOL_ICON = {
  messages: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="8" rx="1.5" stroke="#378add" stroke-width="1.1"/><path d="M5 7h6M5 9h4" stroke="#378add" stroke-width="1.1" stroke-linecap="round"/></svg>',
};

export default function HomePage({ bellSlot }) {
  const [user, setUser]               = useState(null);
  const [worldStatus, setWorldStatus] = useState(null);
  const [toggling, setToggling]       = useState(false);
  const [apps, setApps]               = useState([]);
  const [showWizard, setShowWizard]   = useState(false);
  const [configApp, setConfigApp]     = useState(null);

  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    fetch("/api/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) { window.location.href = "/login"; return; }
        setUser(data);
        document.title = `Anima — ${data.name}`;
      })
      .catch(() => { window.location.href = "/login"; });
    fetchStatus();
    loadApps();
    checkPendingMessages();
  }, []);

  function checkPendingMessages() {
    fetch("/api/pending-messages")
      .then(r => r.ok ? r.json() : { count: 0 })
      .then(data => setPendingCount(data.count || 0))
      .catch(() => {});
  }

  function fetchStatus() {
    fetch(`/api/worlds/${WORLD_ID}/status`)
      .then(r => r.json())
      .then(data => setWorldStatus(data.status))
      .catch(() => setWorldStatus("stopped"));
  }

  function loadApps() {
    fetch("/api/apps")
      .then(r => r.ok ? r.json() : [])
      .then(setApps)
      .catch(() => {});
  }

  async function toggleWorld() {
    if (toggling) return;
    setToggling(true);
    const action = worldStatus === "running" ? "stop" : "start";
    try {
      const res = await fetch(`/api/worlds/${WORLD_ID}/${action}`, { method: "POST" });
      const data = await res.json();
      setWorldStatus(data.status);
    } catch { fetchStatus(); }
    finally { setToggling(false); }
  }

  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  function openApp(app) {
    if (app.built_by === "user" && app.url) {
      window.open(app.url, "_blank");
    } else {
      window.open(`/${app.tool_type}?app=${app.id}`, "_blank");
    }
  }

  async function openWorld() {
    try {
      const res = await fetch(`/api/viewer-token?world_id=${WORLD_ID}`);
      const { token } = await res.json();
      window.open(`/worlds/${WORLD_ID}?viewer=${token}`, "_blank");
    } catch {
      window.open(`/worlds/${WORLD_ID}`, "_blank");
    }
  }

  function onAppCreated(app) {
    setShowWizard(false);
    loadApps();
    window.open(`/${app.tool_type}?app=${app.id}`, "_blank");
  }

  const running    = worldStatus === "running";
  const firstName  = user?.name?.split(" ")[0] ?? "";

  return (
    <div className={homeStyles.page}>
      <div className={homeStyles.inner}>

        {configApp && (
          <AppConfig
            app={configApp}
            user={user}
            onClose={() => setConfigApp(null)}
            onSaved={(updated) => {
              setApps(prev => prev.map(a => a.id === updated.id ? updated : a));
              setConfigApp(null);
            }}
          />
        )}

        {showWizard && (
          <AppWizard
            user={user}
            onClose={() => setShowWizard(false)}
            onCreated={onAppCreated}
          />
        )}

        <div className={homeStyles.topbar}>
          <div className={homeStyles.topbarLeft}>
            <span className={homeStyles.logo}>Anima</span>
            {user && (
              <span className={homeStyles.welcome}>
                {greeting()}, <span className={homeStyles.welcomeName}>{firstName}</span>
              </span>
            )}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {bellSlot}
            <button className={homeStyles.signOutBtn} onClick={signOut}>Sign out</button>
          </div>
        </div>

        {pendingCount > 0 && apps.filter(a => a.tool_type === "messages").length === 0 && (
          <div className={homeStyles.nudgeBanner} onClick={() => setShowWizard(true)}>
            <span className={homeStyles.nudgeIcon}>📬</span>
            <span className={homeStyles.nudgeText}>
              You have {pendingCount} unread message{pendingCount > 1 ? "s" : ""} — create a Messages app to read {pendingCount > 1 ? "them" : "it"}
            </span>
            <span className={homeStyles.nudgeAction}>Create app →</span>
          </div>
        )}

        <p className={homeStyles.sectionLabel}>Your worlds</p>
        <div className={homeStyles.worldCard}>
          <div className={homeStyles.worldTop}>
            <div className={homeStyles.worldLeft}>
              <div className={`${homeStyles.dot} ${running ? homeStyles.dotRunning : homeStyles.dotStopped}`} />
              <div>
                <p className={homeStyles.worldName}>{WORLD_NAME}</p>
                <p className={`${homeStyles.worldStatusText} ${running ? homeStyles.statusRunning : homeStyles.statusStopped}`}>
                  {worldStatus === null ? "Checking..." : running ? "Running" : "Stopped"}
                </p>
              </div>
            </div>
            <div className={homeStyles.worldActions}>
              <button className={running ? homeStyles.btnStop : homeStyles.btnBoot} onClick={toggleWorld} disabled={toggling || worldStatus === null}>
                {toggling ? "..." : running ? "Stop" : "Start"}
              </button>
              <button className={homeStyles.btnOpen} disabled={!running} onClick={openWorld}>
                Open →
              </button>
            </div>
          </div>
          <div className={homeStyles.worldStats}>
            {[["12","Actors"],["3","Companions"],["9","NPCs"],["4","Players"]].map(([n,l]) => (
              <div key={l} className={homeStyles.stat}>
                <p className={homeStyles.statN}>{n}</p>
                <p className={homeStyles.statL}>{l}</p>
              </div>
            ))}
          </div>
        </div>

        <p className={homeStyles.sectionLabel}>Applications</p>
        <div className={homeStyles.appGrid}>
          {apps.map(app => (
            <div key={app.id} className={homeStyles.appCard} onClick={() => openApp(app)}>
              <div className={homeStyles.appTop}>
                <div className={homeStyles.appIcon} dangerouslySetInnerHTML={{__html: TOOL_ICON[app.tool_type] || TOOL_ICON.messages}} />
                <span className={homeStyles.appTypeBadge} style={app.built_by === "user" ? {background:"rgba(176,92,8,.07)",color:"#854f0b",borderColor:"rgba(176,92,8,.13)"} : {}}>
                {app.built_by === "user" ? "custom" : app.tool_type}
              </span>
              </div>
              <p className={homeStyles.appName}>{app.name}</p>
              <p className={homeStyles.appMeta}>{WORLD_NAME}</p>
              <div className={homeStyles.appFooter}>
                <button className={homeStyles.btnAppConfigure} onClick={e => { e.stopPropagation(); setConfigApp(app); }}>Configure</button>
                <button className={homeStyles.btnAppOpen} onClick={e => { e.stopPropagation(); openApp(app); }}>Open →</button>
              </div>















            </div>
          ))}
          <div className={homeStyles.appCardNew} onClick={() => setShowWizard(true)}>
            <div className={homeStyles.newPlus}>+</div>
            <p className={homeStyles.newLabel}>New application</p>
          </div>
        </div>

        <p className={homeStyles.sectionLabel}>Client communication</p>
        <div className={homeStyles.toolsGrid} style={{marginBottom: "2.5rem"}}>
          {COMM_TOOLS.map(t => (
            <div key={t.name} className={`${homeStyles.toolCard} ${t.live ? homeStyles.toolCardLive : ""}`}
              onClick={t.live ? () => setShowWizard(true) : undefined}
              style={t.live ? {cursor:"pointer"} : {}}>
              <span className={t.live ? homeStyles.liveBadge : homeStyles.soonBadge}>{t.live ? "live" : "soon"}</span>
              <div className={homeStyles.toolIcon} style={{background: t.iconBg, border: `1px solid ${t.iconBd}`}} dangerouslySetInnerHTML={{__html: t.svg}} />
              <p className={homeStyles.toolName}>{t.name}</p>
              <p className={homeStyles.toolDesc}>{t.desc}</p>
            </div>
          ))}
        </div>

        <p className={homeStyles.sectionLabel}>Builder tools</p>
        <div className={homeStyles.toolsGrid} style={{marginBottom: "2.5rem"}}>
          {BUILDER_TOOLS.map(t => (
            <div key={t.name} className={homeStyles.toolCard}>
              <span className={homeStyles.soonBadge}>soon</span>
              <div className={homeStyles.toolIcon} dangerouslySetInnerHTML={{__html: t.svg}} />
              <p className={homeStyles.toolName}>{t.name}</p>
              <p className={homeStyles.toolDesc}>{t.desc}</p>
            </div>
          ))}
        </div>

        <p className={homeStyles.sectionLabel}>Developer</p>
        <div className={homeStyles.toolsGrid}>
          <div className={`${homeStyles.toolCard} ${homeStyles.toolCardLive}`} style={{cursor:"pointer"}} onClick={() => window.location.href="/developer"}>
            <span className={homeStyles.liveBadge}>live</span>
            <div className={homeStyles.toolIcon} style={{background:"rgba(176,92,8,.07)",border:"1px solid rgba(176,92,8,.13)"}}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 2a4 4 0 100 8 4 4 0 000-8zM7.17 7.83L2 13v1.5h2.5v-1.5H6v-1.5h1.5l.67-.67A4 4 0 007.17 7.83z" stroke="#b05c08" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <p className={homeStyles.toolName}>API keys</p>
            <p className={homeStyles.toolDesc}>Create and manage keys for your tools.</p>
          </div>
        </div>

      </div>
    </div>
  );
}

const COMM_TOOLS = [
  { name: "Messages",         desc: "Text your contacts in the world.",     live: true,  iconBg: "rgba(55,138,221,.07)",  iconBd: "rgba(55,138,221,.13)",  svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="8" rx="1.5" stroke="#378add" stroke-width="1.1"/><path d="M5 7h6M5 9h4" stroke="#378add" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { name: "Voice call",       desc: "Call a contact, live TTS response.",   live: false, iconBg: "rgba(29,158,117,.07)",  iconBd: "rgba(29,158,117,.13)",  svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4.5C4 3.1 5.1 2 6.5 2S9 3.1 9 4.5 7.9 7 6.5 7 4 5.9 4 4.5z" stroke="#1d9e75" stroke-width="1.1"/><path d="M2 13c0-2.5 2-4 4.5-4" stroke="#1d9e75" stroke-width="1.1" stroke-linecap="round"/><path d="M11 9l2 2-2 2M13 11H9" stroke="#1d9e75" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  { name: "Video call",       desc: "Face-to-face with your actor.",         live: false, iconBg: "rgba(127,119,221,.07)", iconBd: "rgba(127,119,221,.13)", svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="4" width="9" height="7" rx="1.5" stroke="#7f77dd" stroke-width="1.1"/><path d="M11 6.5l3-2v7l-3-2" stroke="#7f77dd" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>' },
  { name: "Live feed",        desc: "Your actor's world right now.",         live: false, iconBg: "rgba(176,92,8,.07)",   iconBd: "rgba(176,92,8,.13)",   svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v4M8 10v4M2 8h4M10 8h4" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round"/><circle cx="8" cy="8" r="2" stroke="#b05c08" stroke-width="1.1"/></svg>' },
  { name: "Notifications",    desc: "Alerts when things happen.",            live: false, iconBg: "rgba(216,90,48,.07)",  iconBd: "rgba(216,90,48,.13)",  svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2C5.8 2 4 3.8 4 6v4l-1.5 2h11L12 10V6c0-2.2-1.8-4-4-4z" stroke="#d85a30" stroke-width="1.1"/><path d="M6.5 13.5a1.5 1.5 0 003 0" stroke="#d85a30" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { name: "Relationship map", desc: "Visual graph of your contacts.",        live: false, iconBg: "rgba(55,138,221,.07)",  iconBd: "rgba(55,138,221,.13)",  svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="2" stroke="#378add" stroke-width="1.1"/><circle cx="12" cy="4" r="2" stroke="#378add" stroke-width="1.1"/><circle cx="12" cy="12" r="2" stroke="#378add" stroke-width="1.1"/><path d="M6 8h2.5M10.2 5.2L6.8 7.2M10.2 10.8L6.8 8.8" stroke="#378add" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { name: "Journal",          desc: "Your actor's private thoughts.",        live: false, iconBg: "rgba(29,158,117,.07)",  iconBd: "rgba(29,158,117,.13)",  svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M3 7h7M3 10h8M3 13h5" stroke="#1d9e75" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { name: "Location tracker", desc: "Where your actor is right now.",        live: false, iconBg: "rgba(127,119,221,.07)", iconBd: "rgba(127,119,221,.13)", svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2C5.2 2 3 4.2 3 7c0 3.5 5 8 5 8s5-4.5 5-8c0-2.8-2.2-5-5-5z" stroke="#7f77dd" stroke-width="1.1"/><circle cx="8" cy="7" r="1.5" fill="#7f77dd"/></svg>' },
];

const BUILDER_TOOLS = [
  { name: "World wizard",      desc: "Create new simulation worlds.",  svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1" stroke="#b05c08" stroke-width="1.1"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="#b05c08" stroke-width="1.1"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="#b05c08" stroke-width="1.1"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="#b05c08" stroke-width="1.1"/></svg>' },
  { name: "Actor editor",      desc: "Design psychology and voice.",   svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="3" stroke="#b05c08" stroke-width="1.1"/><path d="M2 14c0-3.314 2.686-5 6-5s6 1.686 6 5" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { name: "Place editor",      desc: "Map-first venue setup.",         svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="#b05c08" stroke-width="1.1"/><circle cx="8" cy="8" r="1.5" fill="#b05c08"/><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { name: "Scenario designer", desc: "Timeline events and arcs.",      svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12V6l6-4 6 4v6" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><rect x="5" y="8" width="6" height="6" rx="0.5" stroke="#b05c08" stroke-width="1.1"/></svg>' },
  { name: "Narrative weaver",  desc: "Relationship graph design.",     svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="2" stroke="#b05c08" stroke-width="1.1"/><circle cx="12" cy="4" r="2" stroke="#b05c08" stroke-width="1.1"/><circle cx="12" cy="12" r="2" stroke="#b05c08" stroke-width="1.1"/><path d="M6 8h2.5M10.2 5.2L6.8 7.2M10.2 10.8L6.8 8.8" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round"/></svg>' },
];
