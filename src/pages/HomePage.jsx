import { useState, useEffect } from "react";
import homeStyles from "./HomePage.module.css";

const WORLD_ID = "e7368020-fc19-4914-95ac-2f7c5508a13c";

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function HomePage() {
  const [user, setUser]               = useState(null);
  const [worldStatus, setWorldStatus] = useState(null);
  const [toggling, setToggling]       = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) { window.location.href = "/login"; return; }
        setUser(data);
      })
      .catch(() => { window.location.href = "/login"; });
    fetchStatus();
  }, []);

  function fetchStatus() {
    fetch(`/api/worlds/${WORLD_ID}/status`)
      .then(r => r.json())
      .then(data => setWorldStatus(data.status))
      .catch(() => setWorldStatus("stopped"));
  }

  async function toggleWorld() {
    if (toggling) return;
    setToggling(true);
    const action = worldStatus === "running" ? "stop" : "start";
    try {
      const res = await fetch(`/api/worlds/${WORLD_ID}/${action}`, { method: "POST" });
      const data = await res.json();
      setWorldStatus(data.status);
    } catch {
      fetchStatus();
    } finally {
      setToggling(false);
    }
  }

  async function signOut() {
    await fetch("/api/auth/signout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  }

  const running = worldStatus === "running";
  const firstName = user?.name?.split(" ")[0] ?? "";

  return (
    <div className={homeStyles.page}>
      <div className={homeStyles.inner}>

        <div className={homeStyles.topbar}>
          <div className={homeStyles.topbarLeft}>
            <span className={homeStyles.logo}>Anima</span>
            {user && (
              <span className={homeStyles.welcome}>
                {greeting()}, <span className={homeStyles.welcomeName}>{firstName}</span>
              </span>
            )}
          </div>
          <button className={homeStyles.signOutBtn} onClick={signOut}>Sign out</button>
        </div>

        <p className={homeStyles.sectionLabel}>Your worlds</p>

        <div className={homeStyles.worldCard}>
          <div className={homeStyles.worldTop}>
            <div className={homeStyles.worldLeft}>
              <div className={`${homeStyles.dot} ${running ? homeStyles.dotRunning : homeStyles.dotStopped}`} />
              <div>
                <p className={homeStyles.worldName}>Stockholm</p>
                <p className={`${homeStyles.worldStatusText} ${running ? homeStyles.statusRunning : homeStyles.statusStopped}`}>
                  {worldStatus === null ? "Checking\u2026" : running ? "Running" : "Stopped"}
                </p>
              </div>
            </div>
            <div className={homeStyles.worldActions}>
              <button
                className={running ? homeStyles.btnStop : homeStyles.btnBoot}
                onClick={toggleWorld}
                disabled={toggling || worldStatus === null}
              >
                {toggling ? "\u2026" : running ? "Stop" : "Start"}
              </button>
              <button
                className={homeStyles.btnOpen}
                disabled={!running}
                onClick={() => window.open(`/worlds/${WORLD_ID}`, "_blank")}
              >
                Open →
              </button>
            </div>
          </div>
          <div className={homeStyles.worldStats}>
            {[["12","Actors"],["3","Companions"],["9","NPCs"],["1","Players"]].map(([n,l]) => (
              <div key={l} className={homeStyles.stat}>
                <p className={homeStyles.statN}>{n}</p>
                <p className={homeStyles.statL}>{l}</p>
              </div>
            ))}
          </div>
        </div>

        <p className={homeStyles.sectionLabel}>Builder tools</p>

        <div className={homeStyles.toolsGrid}>
          {TOOLS.map(t => (
            <div key={t.name} className={homeStyles.toolCard}>
              <span className={homeStyles.soonBadge}>soon</span>
              <div className={homeStyles.toolIcon} dangerouslySetInnerHTML={{__html: t.svg}} />
              <p className={homeStyles.toolName}>{t.name}</p>
              <p className={homeStyles.toolDesc}>{t.desc}</p>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}

const TOOLS = [
  { name: "World Wizard",      desc: "Create and configure new simulation worlds.",  svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="5" height="5" rx="1" stroke="#b05c08" stroke-width="1.1"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="#b05c08" stroke-width="1.1"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="#b05c08" stroke-width="1.1"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="#b05c08" stroke-width="1.1"/></svg>' },
  { name: "Actor Editor",      desc: "Design psychology, economics, and voice.",      svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="5" r="3" stroke="#b05c08" stroke-width="1.1"/><path d="M2 14c0-3.314 2.686-5 6-5s6 1.686 6 5" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { name: "Place Editor",      desc: "Map-first venue and location setup.",           svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.5" stroke="#b05c08" stroke-width="1.1"/><circle cx="8" cy="8" r="1.5" fill="#b05c08"/><path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round"/></svg>' },
  { name: "Scenario Designer", desc: "Timeline events and emotional arcs.",           svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 12V6l6-4 6 4v6" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/><rect x="5" y="8" width="6" height="6" rx="0.5" stroke="#b05c08" stroke-width="1.1"/></svg>' },
  { name: "Narrative Weaver",  desc: "Relationship graph and arc design.",            svg: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="2" stroke="#b05c08" stroke-width="1.1"/><circle cx="12" cy="4" r="2" stroke="#b05c08" stroke-width="1.1"/><circle cx="12" cy="12" r="2" stroke="#b05c08" stroke-width="1.1"/><path d="M6 8h2.5M10.2 5.2L6.8 7.2M10.2 10.8L6.8 8.8" stroke="#b05c08" stroke-width="1.1" stroke-linecap="round"/></svg>' },
];
