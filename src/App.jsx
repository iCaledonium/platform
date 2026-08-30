import { Routes, Route, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import LabPage             from "./pages/LabPage.jsx";
import LabHomePage         from "./pages/LabHomePage.jsx";
import LabIncidentsPage    from "./pages/LabIncidentsPage.jsx";
import LabTestManagerPage  from "./pages/LabTestManagerPage.jsx";
import SignupLabPage       from "./pages/SignupLabPage.jsx";
import BehaviorLabPage     from "./pages/BehaviorLabPage.jsx";
import AvatarLabPage       from "./pages/AvatarLabPage.jsx";
import TransportLabPage    from "./pages/TransportLabPage.jsx";
import WatcherPanel, { watcherIsFollowing } from "./components/WatcherPanel.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import EnrollPage from "./pages/EnrollPage.jsx";
import InvitePage from "./pages/InvitePage.jsx";
import ClaimSharePage from "./pages/ClaimSharePage.jsx";
import AdminUsersPage from "./pages/AdminUsersPage.jsx";
import HomePage from "./pages/HomePage.jsx";
import DeveloperPage from "./pages/DeveloperPage.jsx";
import MessagesPage from "./pages/MessagesPage.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import VoicemailPage from "./pages/VoicemailPage.jsx";
import ActorsGalleryPage from "./pages/ActorsGalleryPage.jsx";
import CharacterWizard from "./pages/CharacterWizard.jsx";
import ActorsEditorPage from "./pages/ActorsEditorPage.jsx";
import DeployWizardPage from "./pages/DeployWizardPage.jsx";
import WorldsPage from "./pages/WorldsPage.jsx";
import WorldEditorPage from "./pages/WorldEditorPage.jsx";
import WorldActorPage  from "./pages/WorldActorPage.jsx";
import WorldPage       from "./pages/WorldPage.jsx";
import KnockEncounterPage from "./pages/KnockEncounterPage.jsx";
import KnockActorDoor      from "./pages/KnockActorDoor.jsx";
import VenuePage from "./pages/VenuePage.jsx";

// The Test Lab watcher rides ABOVE the router as an overlay, never inside a
// page's view: it shows on any /lab route and on any door run carrying the
// lab's ?eid=/?lab= params — and because it stays mounted across those
// navigations, the attached watcher session (and its chat) survives walking
// from the lab config page into the scene.
//
// Session 155 — the route test alone was not enough, and the way it failed was
// invisible. The world enter scene is a bare /world/:id with NO query string,
// so walking a run from the lab into the world made `show` false, unmounted the
// panel and took a live watcher down with it — and nothing said so, because the
// thing that would have reported the loss is the thing that disappeared.
// Enumerating more routes would only move the edge: a run can continue to a
// venue, to /messages, anywhere the developer needs to look.
//
// So an OPEN PANEL now keeps itself on screen (watcherIsFollowing, a per-tab
// flag the panel sets while it is open and clears on ×). Route match is what
// OFFERS the watcher on the lab's own pages; the flag is what KEEPS it once
// somebody has attached one. Both are still gated by the bridge probe inside
// the panel, so a machine with no local bridge renders nothing either way and
// the public page is untouched.
function LabWatcherOverlay() {
  const location = useLocation();
  const qs = new URLSearchParams(location.search);
  // Magnus's rule (2026-08-29): the watcher lives in LAB TERRITORY ONLY —
  // /lab pages and runs explicitly stamped ?lab=. And each surface BINDS its
  // own conversation: the encounter lab must never host the transport watcher.
  const show = location.pathname.startsWith("/lab") || qs.has("lab");
  if (!show) return null;
  let bound = null;
  if (location.pathname.startsWith("/lab/actor/apartment/encounter")) bound = "Feature - Actor Apartment Encounter";
  else if (location.pathname.startsWith("/lab/transport") || location.pathname.startsWith("/lab/world/transport")) bound = "Runtime - Transport Engine";
  else if (location.pathname.startsWith("/lab/user/signup")) bound = "Feature - User Signup and Creation";
  else if (location.pathname.startsWith("/lab/user/avatar")) bound = "Feature - User Avatar";
  else if (location.pathname.startsWith("/lab/world/behavior")) bound = "Runtime - World Behaviour";
  else if (qs.get("lab") === "behavior") bound = "Runtime - World Behaviour";
  else if (qs.get("lab") === "transport") bound = "Runtime - Transport Engine";
  else if (qs.has("lab") && location.pathname.includes("/knock/")) bound = "Feature - Actor Apartment Encounter";
  return <WatcherPanel bound={bound} />;
}

import "./pages/runtimeCheck.js";   // Session 152 — window.__checkRuntimeWalk

const CONV_TO_TOOL = {
  text_thread:   "messages",
  voice_message: "voicemail",
  call_request:  "voice",
  email_thread:  "email",
  call:          "voice",
  video_call:    "video",
  missed_knock:  "missed_knock",
};

const TOOL_LABELS = {
  messages:     { label: "SMS",          color: "#378add", bg: "rgba(55,138,221,.1)"  },
  calendar:     { label: "Calendar",     color: "#b05c08", bg: "rgba(176,92,8,.1)"    },
  voicemail:    { label: "Voicemail",    color: "#1d9e75", bg: "rgba(29,158,117,.1)"  },
  voice:        { label: "Voice",        color: "#1d9e75", bg: "rgba(29,158,117,.1)"  },
  email:        { label: "Email",        color: "#7f77dd", bg: "rgba(127,119,221,.1)" },
  video:        { label: "Video",        color: "#b05c08", bg: "rgba(176,92,8,.1)"    },
  missed_knock: { label: "Missed visit", color: "#b05c08", bg: "rgba(176,92,8,.1)"    },
};

function TypeBadge({ convType }) {
  const toolType = CONV_TO_TOOL[convType] || "messages";
  const meta = TOOL_LABELS[toolType] || TOOL_LABELS.messages;
  return (
    <span style={{
      fontFamily: "'DM Sans',system-ui,sans-serif",
      fontSize: 9, letterSpacing: ".1em", textTransform: "uppercase",
      padding: "2px 6px", borderRadius: 4,
      background: meta.bg, color: meta.color,
      border: `1px solid ${meta.color}33`,
      flexShrink: 0,
    }}>{meta.label}</span>
  );
}

function BellSlot({ unread, onClick, notifications }) {
  const [hover, setHover] = useState(false);
  const breakdown = Object.entries(
    (notifications || []).filter(n => !n.read_at).reduce((acc, n) => {
      const tool = CONV_TO_TOOL[n.conversation_type] || "messages";
      acc[tool] = (acc[tool] || 0) + 1;
      return acc;
    }, {})
  );
  return (
    <div style={{ position: "relative" }} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button onClick={onClick} style={{
        position:"relative", width:36, height:36, borderRadius:"50%",
        background:"none", border:"1px solid rgba(0,0,0,.08)",
        display:"flex", alignItems:"center", justifyContent:"center",
        cursor:"pointer", color:"#1a1814",
      }}>
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M8 2C5.8 2 4 3.8 4 6v4l-1.5 2h11L12 10V6c0-2.2-1.8-4-4-4z" stroke="currentColor" strokeWidth="1.1"/>
          <path d="M6.5 13.5a1.5 1.5 0 003 0" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/>
        </svg>
        {unread > 0 && (
          <span style={{
            position:"absolute", top:-3, right:-3, width:16, height:16, borderRadius:"50%",
            background:"#378add", color:"#fff", display:"flex", alignItems:"center", justifyContent:"center",
            fontSize:9, fontWeight:500, fontFamily:"'DM Sans',system-ui,sans-serif", border:"2px solid #eeecea",
          }}>{unread > 9 ? "9+" : unread}</span>
        )}
      </button>
      {hover && breakdown.length > 0 && (
        <div style={{
          position:"absolute", top:44, right:0,
          background:"rgba(26,24,20,.92)", backdropFilter:"blur(20px)",
          border:"1px solid rgba(255,255,255,.07)", borderRadius:10,
          padding:"8px 12px", minWidth:120, zIndex:9999,
        }}>
          {breakdown.map(([tool, count]) => {
            const meta = TOOL_LABELS[tool] || TOOL_LABELS.messages;
            return (
              <div key={tool} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,padding:"3px 0"}}>
                <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:meta.color}}>{meta.label}</span>
                <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"rgba(255,255,255,.6)",fontWeight:500}}>{count}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatTime(isoStr) {
  if (!isoStr) return "";
  const data = new Date(isoStr);
  return data.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function formatSection(isoStr) {
  if (!isoStr) return "Earlier";
  const data = new Date(isoStr);
  const now = new Date();
  const diff = Math.floor((now - data) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return data.toLocaleDateString("sv-SE", { weekday: "long" });
}

function groupByDate(notifs) {
  const groups = [];
  let currentSection = null;
  for (const n of notifs) {
    const section = formatSection(n.inserted_at);
    if (section !== currentSection) {
      groups.push({ type: "header", label: section });
      currentSection = section;
    }
    groups.push({ type: "notif", ...n });
  }
  return groups;
}

function initials(name) {
  return name?.split(" ").map(n => n[0]).join("").slice(0,2).toUpperCase() || "?";
}

export default function App() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState([]);
  const [homeKnock, setHomeKnock] = useState(null); // {actor_id, actor_name, photo_url, address, world_id, home_place_id}
  const [playerApproach, setPlayerApproach] = useState(null); // {actor_id, actor_name, photo_url, world_id, narrative}
  const [toasts, setToasts]               = useState([]);
  const [showCentre, setShowCentre]       = useState(false);
  const esRef                              = useRef(null);
  const location                           = useLocation();
  // /invite carries a token in the path, so this cannot stay an exact-match
  // list. Getting it wrong is not cosmetic: an invitee has no session, and the
  // full shell immediately opens an SSE stream and polls notifications, both of
  // which 401 in a loop behind the one page that must work signed out.
  // Session 158 - /share/:token joins this list for exactly the reason above.
  // A share link is opened by strangers, including people with no account on
  // this platform at all; behind the full shell every one of them would sit
  // through an SSE stream and a notification poll 401ing in a loop.
  const isAuthPage = ["/login", "/enroll"].includes(location.pathname)
                  || location.pathname.startsWith("/invite/")
                  || location.pathname.startsWith("/share/");

  useEffect(() => {
    if (isAuthPage) return;
    loadNotifications();
    connectSSE();
    return () => { if (esRef.current) esRef.current.close(); };
  }, [isAuthPage]);

  function loadNotifications() {
    fetch("/api/notifications")
      .then(r => r.ok ? r.json() : [])
      .then(setNotifications)
      .catch(() => {});
  }

  const clearedIdsRef = useRef(new Set());

  function connectSSE() {
    if (esRef.current) esRef.current.close();
    const es = new EventSource("/api/stream");
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === "knock_user_door") {
          setHomeKnock(payload);
          return;
        }
        if (payload.type === "knock_actor_left") {
          // Actor gave up waiting — clear the door prompt and add missed knock notification
          setHomeKnock(prev => {
            if (prev?.actor_id === payload.actor_id) {
              const now = new Date().toISOString();
              const missedKnock = {
                id:               `missed-knock-${payload.actor_id}-${Date.now()}`,
                type:             "missed_knock",
                sender_name:      prev.actor_name,
                sender_actor_id:  payload.actor_id,
                photo_url:        prev.photo_url,
                world_id:         payload.world_id,
                content:          `Knocked on your door and left.`,
                inserted_at:      now,
                read_at:          null,
                conversation_type: "missed_knock",
              };
              setNotifications(ns => [missedKnock, ...ns]);
              return null;
            }
            return prev;
          });
          return;
        }
        if (payload.type === "player_approach") {
          setPlayerApproach(payload);
          return;
        }
        if (payload.type === "new_message") {
          const notifId = payload.notif_id;
          // No server-assigned ID = can't track → skip
          if (!notifId) return;
          // Already cleared this session → don't re-add
          if (clearedIdsRef.current.has(notifId)) return;
          const notif = {
            id:                notifId,
            sender_actor_id:   payload.sender_id,
            sender_name:       payload.sender_name,
            sender_actor_type: payload.sender_actor_type,
            content:           payload.content,
            app_id:            payload.app_id || null,
            conversation_type: payload.conv_type || "text_thread",
            // has_app intentionally NOT set from SSE — computed server-side on GET
            read_at:           null,
            inserted_at:       payload.sent_at || new Date().toISOString(),
          };
          setNotifications(prev => {
            if (prev.find(n => n.id === notif.id)) return prev;
            return [notif, ...prev];
          });
          const currentUrl = window.location.href;
          const alreadyOpen = currentUrl.includes(`contact=${payload.sender_id}`);
          if (!alreadyOpen) showToast(notif);
        }
      } catch {}
    };
    es.onerror = () => { es.close(); setTimeout(connectSSE, 5000); };
  }

  function showToast(notif) {
    const id = notif.id;
    setToasts(prev => [...prev.slice(-2), { ...notif, toastId: id }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.toastId !== id)), 6000);
  }

  async function markRead(id) {
    await fetch(`/api/notifications/${id}/read`, { method: "PATCH" }).catch(() => {});
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
  }

  async function clearNotif(id) {
    await fetch(`/api/notifications/${id}`, { method: "DELETE" }).catch(() => {});
    clearedIdsRef.current.add(id);
    setNotifications(prev => prev.filter(n => n.id !== id));
  }

  async function clearAll() {
    await fetch("/api/notifications", { method: "DELETE" }).catch(() => {});
    notifications.forEach(n => clearedIdsRef.current.add(n.id));
    setNotifications([]);
  }

  function openFromNotif(notif) {
    markRead(notif.id);
    setShowCentre(false);
    const convType = notif.conversation_type || notif.conv_type || "text_thread";
    const toolType = CONV_TO_TOOL[convType] || "messages";
    const contactParam = notif.sender_actor_id ? `&contact=${notif.sender_actor_id}` : "";
    // Always do fresh app lookup — never rely on stale has_app from notification
    if (notif.app_id) {
      window.open(`/messages?app=${notif.app_id}${contactParam}`, "_blank");
      return;
    }
    fetch("/api/apps")
      .then(r => r.ok ? r.json() : [])
      .then(apps => {
        // First try to find app matching both world_id and tool_type
        const app = apps.find(a => a.tool_type === toolType && a.world_id === notif.world_id)
                 || apps.find(a => a.tool_type === toolType);
        if (app) {
          window.open(`/messages?app=${app.id}${contactParam}`, "_blank");
        } else {
          window.location.href = `/home?install=${toolType}&world_id=${notif.world_id || ""}`;
        }
      });
  }

  function openFromToast(toast) {
    setToasts(prev => prev.filter(t => t.toastId !== toast.toastId));
    openFromNotif(toast);
  }

  const unreadCount = notifications.filter(n => !n.read_at).length;
  const grouped = groupByDate(notifications);

  if (isAuthPage) {
    return (
      <Routes>
        <Route path="/login"         element={<LoginPage />} />
        <Route path="/enroll"        element={<EnrollPage />} />
        <Route path="/invite/:token" element={<InvitePage />} />
        <Route path="/share/:token"  element={<ClaimSharePage />} />
        <Route path="*"              element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <>
      <LabWatcherOverlay />
      <Routes>
        <Route path="/home"         element={<HomePage />} />
        <Route path="/world/:worldId"                       element={<WorldPage />} />
        <Route path="/my-worlds"    element={<WorldsPage />} />
        <Route path="/my-worlds/:worldId"                   element={<WorldEditorPage />} />
        <Route path="/my-worlds/:worldId/actors/:actorId"   element={<WorldActorPage />} />
        <Route path="/developer"    element={<DeveloperPage />} />
        <Route path="/admin/users"  element={<AdminUsersPage />} />
        <Route path="/messages"     element={<MessagesPage />} />
        <Route path="/calendar"     element={<CalendarPage />} />
        <Route path="/voicemail"    element={<VoicemailPage />} />
        <Route path="/lab/home" element={<LabHomePage />} />
        {/* Incidents and the manager span every bench, so they stay UNBOUND:
            the panel falls back to last-used there, and the incident rows
            navigate to the owning bench before handing anything over. */}
        <Route path="/lab/home/incidents"   element={<LabIncidentsPage />} />
        <Route path="/lab/home/testmanager" element={<LabTestManagerPage />} />
        <Route path="/lab/actor/apartment/encounter" element={<LabPage />} />
        <Route path="/lab/world/transport/actor" element={<TransportLabPage />} />
        <Route path="/lab/transport/actor" element={<Navigate to="/lab/world/transport/actor" replace />} />
        <Route path="/lab/user/signup" element={<SignupLabPage />} />
        <Route path="/lab/world/behavior" element={<BehaviorLabPage />} />
        <Route path="/lab/user/avatar" element={<AvatarLabPage />} />
        <Route path="/lab" element={<Navigate to="/lab/home" replace />} />
        <Route path="/actors"            element={<ActorsGalleryPage />} />
        <Route path="/actors/new"        element={<CharacterWizard />} />
        {/* The same wizard in avatar mode: your own body, three steps. */}
        <Route path="/me/avatar"         element={<CharacterWizard mode="avatar" />} />
        <Route path="/actors/:id"        element={<ActorsEditorPage />} />
        <Route path="/actors/:id/deploy" element={<DeployWizardPage />} />
        {/* Session 152 — the player knocking on someone's door.
            Keyed on whose door it is, so it survives a reload and can be
            returned to. /encounter/knock/:encounterId stays for the other
            direction: an actor knocking on YOUR door, which arrives through the
            overlay below and is your address, not theirs. */}
        <Route path="/world/:worldId/knock/:actorId/door" element={<KnockActorDoor />} />
        <Route path="/encounter/knock/:encounterId" element={<KnockEncounterPage />} />
        <Route path="/world/:worldId/venue/:venueId"        element={<VenuePage />} />
        <Route path="*"             element={<Navigate to="/login" replace />} />
      </Routes>

      {/* Bell — portalled into HomePage topbar */}
      {location.pathname === "/home" && document.getElementById("topbar-bell") &&
        ReactDOM.createPortal(
          <BellSlot unread={unreadCount} onClick={() => setShowCentre(v => !v)} notifications={notifications} />,
          document.getElementById("topbar-bell")
        )
      }

      {/* Notification centre panel */}
      {showCentre && (
        <div
          onClick={() => setShowCentre(false)}
          style={{position:"fixed",inset:0,zIndex:9990}}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              position:"fixed", top:0, right:0, bottom:0, width:380,
              background:"rgba(245,242,239,.97)",
              backdropFilter:"blur(40px)", WebkitBackdropFilter:"blur(40px)",
              borderLeft:"1px solid rgba(0,0,0,.07)",
              display:"flex", flexDirection:"column",
              zIndex:9991,
              animation:"ncSlide .2s ease",
            }}
          >
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"1.1rem 1.25rem .9rem",borderBottom:"1px solid rgba(0,0,0,.06)",flexShrink:0}}>
              <span style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:19,fontWeight:500,color:"#1a1814"}}>Notifications</span>
              {notifications.length > 0 && (
                <button onClick={clearAll} style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#a8a5a0",background:"none",border:"none",cursor:"pointer",letterSpacing:".04em"}}>
                  Clear all
                </button>
              )}
            </div>

            <div style={{flex:1,overflowY:"auto"}}>
              {notifications.length === 0 ? (
                <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,color:"#a8a5a0",textAlign:"center",padding:"3rem 0"}}>No notifications</p>
              ) : (
                grouped.map((item, i) => item.type === "header" ? (
                  <p key={i} style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,letterSpacing:".12em",textTransform:"uppercase",color:"#a8a5a0",padding:"10px 14px 4px"}}>{item.label}</p>
                ) : (
                  <NotifItem key={item.id} notif={item} onOpen={openFromNotif} onClear={clearNotif} />
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast notifications */}
      <div style={{position:"fixed",top:20,right:showCentre?400:20,display:"flex",flexDirection:"column",gap:8,zIndex:9999,pointerEvents:"none",transition:"right .2s ease"}}>
        {toasts.map(t => (
          <div key={t.toastId} onClick={() => openFromToast(t)} style={{
            pointerEvents:"all", cursor:"pointer",
            background:"rgba(26,24,20,.92)", backdropFilter:"blur(20px)", WebkitBackdropFilter:"blur(20px)",
            border:"1px solid rgba(255,255,255,.07)", borderRadius:14,
            padding:"11px 14px", width:300,
            display:"flex", alignItems:"flex-start", gap:10,
            boxShadow:"0 8px 32px rgba(0,0,0,.3)",
            animation:"toastIn .25s ease",
          }}>
            <div style={{width:34,height:34,borderRadius:"50%",background:"rgba(181,148,90,.15)",border:"1px solid rgba(181,148,90,.2)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,color:"#b5945a",flexShrink:0,fontFamily:"'DM Sans',system-ui,sans-serif"}}>
              {initials(t.sender_name)}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,fontWeight:500,color:"rgba(255,255,255,.9)",margin:"0 0 2px"}}>{t.sender_name}</p>
              <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"rgba(255,255,255,.4)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",margin:0}}>{t.content}</p>
            </div>
            <button onClick={e => { e.stopPropagation(); setToasts(prev => prev.filter(x => x.toastId !== t.toastId)); }}
              style={{background:"none",border:"none",color:"rgba(255,255,255,.3)",cursor:"pointer",fontSize:13,flexShrink:0}}>✕</button>
          </div>
        ))}
      </div>

      {/* Home knock overlay — hidden on messages page */}
      {homeKnock && location.pathname !== "/messages" && (
        <div style={{position:"fixed",inset:0,zIndex:10000,background:"rgba(0,0,0,.7)",display:"flex",alignItems:"center",justifyContent:"center",padding:24}}>
          <div style={{background:"#1a1814",borderRadius:20,padding:32,maxWidth:380,width:"100%",display:"flex",flexDirection:"column",alignItems:"center",gap:18,boxShadow:"0 24px 64px rgba(0,0,0,.5)"}}>
            {homeKnock.photo_url && (
              <div style={{width:72,height:72,borderRadius:"50%",overflow:"hidden",border:"2px solid rgba(255,255,255,.15)"}}>
                <img src={homeKnock.photo_url} style={{width:"100%",height:"100%",objectFit:"cover"}} alt="" />
              </div>
            )}
            <div style={{textAlign:"center"}}>
              <p style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:22,color:"rgba(255,255,255,.9)",margin:"0 0 8px",fontWeight:500}}>
                {homeKnock.actor_name} is at your door
              </p>
              <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"rgba(255,255,255,.4)",margin:0}}>
                {homeKnock.address}
              </p>
            </div>
            <div style={{display:"flex",gap:10,width:"100%"}}>
              <button onClick={async () => {
                try {
                  const resp = await fetch(`/api/worlds/${homeKnock.world_id}/encounter/start`, {
                    method:"POST", headers:{"Content-Type":"application/json"},
                    body: JSON.stringify({ target_actor_id: homeKnock.actor_id, location_id: homeKnock.home_place_id, trigger: "knock_user_door", visit_reason: homeKnock.visit_reason })
                  });
                  const data = await resp.json();
                  setHomeKnock(null);
                  if (data.encounter_id) {
                    // Fetch user then navigate to standalone encounter page
                    const meResp = await fetch("/api/me");
                    const userData = meResp.ok ? await meResp.json() : null;
                    sessionStorage.setItem("encounterContext", JSON.stringify({
                      world: {
                        id:       homeKnock.world_id,
                        timezone: homeKnock.timezone || "America/Los_Angeles"
                      },
                      user: userData,
                      sceneData: {
                        mode:         "scene",
                        encounter_id: data.encounter_id,
                        trigger:      "knock_user_door",
                        location: {
                          id:       homeKnock.home_place_id || "home",
                          place_id: homeKnock.home_place_id || "home",
                          name:     homeKnock.address || "Home",
                          actors: [{
                            actor_id:  homeKnock.actor_id,
                            name:      homeKnock.actor_name,
                            photo_url: homeKnock.photo_url
                          }]
                        }
                      }
                    }));
                    navigate(`/encounter/knock/${data.encounter_id}`);
                  }
                } catch(e) { console.error("Failed to open door", e); }
              }} style={{flex:1,fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,fontWeight:500,padding:"11px 0",borderRadius:12,border:"none",background:"rgba(255,255,255,.92)",color:"#1a1814",cursor:"pointer"}}>
                Open the door →
              </button>
              <button onClick={() => {
                fetch(`/api/worlds/${homeKnock.world_id}/knock-user-door/decline`, {
                  method:"POST", headers:{"Content-Type":"application/json"},
                  body: JSON.stringify({ actor_id: homeKnock.actor_id })
                }).catch(()=>{});
                setHomeKnock(null);
              }} style={{flex:1,fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,padding:"11px 0",borderRadius:12,border:"1px solid rgba(255,255,255,.15)",background:"rgba(255,255,255,.06)",color:"rgba(255,255,255,.5)",cursor:"pointer"}}>
                Ignore
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Player approach overlay — actor already inside, initiating re-engagement */}
      {playerApproach && (
        <div style={{position:"fixed",inset:0,zIndex:10000,background:"rgba(0,0,0,.5)",display:"flex",alignItems:"flex-end",justifyContent:"center",padding:"0 24px 48px"}}>
          <div style={{background:"#1a1814",borderRadius:20,padding:28,maxWidth:420,width:"100%",display:"flex",flexDirection:"column",gap:16,boxShadow:"0 24px 64px rgba(0,0,0,.5)"}}>
            <div style={{display:"flex",alignItems:"center",gap:14}}>
              {playerApproach.photo_url && (
                <div style={{width:48,height:48,borderRadius:"50%",overflow:"hidden",border:"1px solid rgba(255,255,255,.12)",flexShrink:0}}>
                  <img src={playerApproach.photo_url} style={{width:"100%",height:"100%",objectFit:"cover"}} alt="" />
                </div>
              )}
              <p style={{fontFamily:"'Cormorant Garamond',Georgia,serif",fontSize:17,color:"rgba(255,255,255,.85)",margin:0,fontStyle:"italic",lineHeight:1.4}}>
                {playerApproach.narrative || `${playerApproach.actor_name} walks over.`}
              </p>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={async () => {
                try {
                  await fetch(`/api/worlds/${playerApproach.world_id}/encounter/start`, {
                    method:"POST", headers:{"Content-Type":"application/json"},
                    body: JSON.stringify({ target_actor_id: playerApproach.actor_id, trigger: "player_approach_at_home" })
                  });
                  setPlayerApproach(null);
                  window.location.href = `/home`;
                } catch(e) { console.error("Failed to start encounter", e); }
              }} style={{flex:1,fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,fontWeight:500,padding:"10px 0",borderRadius:12,border:"none",background:"rgba(255,255,255,.92)",color:"#1a1814",cursor:"pointer"}}>
                Engage
              </button>
              <button onClick={() => setPlayerApproach(null)}
                style={{flex:1,fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,padding:"10px 0",borderRadius:12,border:"1px solid rgba(255,255,255,.12)",background:"rgba(255,255,255,.04)",color:"rgba(255,255,255,.4)",cursor:"pointer"}}>
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes ncSlide { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes toastIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      `}</style>
    </>
  );
}


function NotifItem({ notif, onOpen, onClear }) {
  const [hover, setHover] = useState(false);
  const convType = notif.conversation_type || notif.conv_type || "text_thread";
  const toolType = CONV_TO_TOOL[convType] || "messages";

  return (
    <div
      onClick={() => onOpen(notif)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display:"flex", alignItems:"flex-start", gap:10,
        padding:"11px 14px", borderBottom:"1px solid rgba(0,0,0,.04)",
        cursor:"pointer", position:"relative",
        background: hover ? "rgba(255,255,255,.6)" : "transparent",
        opacity: notif.read_at ? .55 : 1,
        transition:"all .1s",
      }}
    >
      <div style={{width:34,height:34,borderRadius:"50%",background:"rgba(181,148,90,.1)",border:"1px solid rgba(181,148,90,.18)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,color:"#b5945a",flexShrink:0,fontFamily:"'DM Sans',system-ui,sans-serif"}}>
        {notif.conversation_type === "missed_knock"
          ? <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#b05c08" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/><circle cx="7" cy="12" r="1" fill="#b05c08"/></svg>
          : initials(notif.sender_name)
        }
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
          <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,fontWeight:500,color:"#1a1814"}}>{notif.sender_name}</span>
          <TypeBadge convType={convType} />
          <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,color:"#a8a5a0",marginLeft:"auto"}}>{formatTime(notif.inserted_at)}</span>
        </div>
        <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#6b6760",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",margin:0}}>
          {notif.content || "Tap to open →"}
        </p>
      </div>
      {!notif.read_at && (
        <div style={{width:6,height:6,borderRadius:"50%",background:"#378add",flexShrink:0,marginTop:5}} />
      )}
      {hover && (
        <button
          onClick={e => { e.stopPropagation(); onClear(notif.id); }}
          style={{
            position:"absolute", right:10, top:"50%", transform:"translateY(-50%)",
            width:18, height:18, borderRadius:"50%",
            background:"#b05c08", border:"none",
            display:"flex", alignItems:"center", justifyContent:"center",
            cursor:"pointer", fontSize:10, color:"#fff", fontWeight:500, lineHeight:1,
          }}
        >✕</button>
      )}
    </div>
  );
}
