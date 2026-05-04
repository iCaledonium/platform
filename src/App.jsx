import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import LoginPage from "./pages/LoginPage.jsx";
import EnrollPage from "./pages/EnrollPage.jsx";
import HomePage from "./pages/HomePage.jsx";
import DeveloperPage from "./pages/DeveloperPage.jsx";
import MessagesPage from "./pages/MessagesPage.jsx";
import CalendarPage from "./pages/CalendarPage.jsx";
import VoicemailPage from "./pages/VoicemailPage.jsx";
import ActorsGalleryPage from "./pages/ActorsGalleryPage.jsx";
import ActorsEditorPage from "./pages/ActorsEditorPage.jsx";
import DeployWizardPage from "./pages/DeployWizardPage.jsx";
import WorldsPage from "./pages/WorldsPage.jsx";

const CONV_TO_TOOL = {
  text_thread:   "messages",
  voice_message: "voicemail",
  call_request:  "voice",
  email_thread:  "email",
  call:          "voice",
  video_call:    "video",
};

const TOOL_LABELS = {
  messages: { label: "SMS",      color: "#378add", bg: "rgba(55,138,221,.1)" },
  calendar: { label: "Calendar", color: "#b05c08", bg: "rgba(176,92,8,.1)" },
  voicemail:{ label: "Voicemail",color: "#1d9e75", bg: "rgba(29,158,117,.1)" },
  voice:    { label: "Voice",    color: "#1d9e75", bg: "rgba(29,158,117,.1)" },
  email:    { label: "Email",    color: "#7f77dd", bg: "rgba(127,119,221,.1)" },
  video:    { label: "Video",    color: "#b05c08", bg: "rgba(176,92,8,.1)"   },
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
  const d = new Date(isoStr);
  return d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
}

function formatSection(isoStr) {
  if (!isoStr) return "Earlier";
  const d = new Date(isoStr);
  const now = new Date();
  const diff = Math.floor((now - d) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("sv-SE", { weekday: "long" });
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
  const [notifications, setNotifications] = useState([]);
  const [toasts, setToasts]               = useState([]);
  const [showCentre, setShowCentre]       = useState(false);
  const esRef                              = useRef(null);
  const location                           = useLocation();
  const isAuthPage = ["/login", "/enroll"].includes(location.pathname);

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

  function connectSSE() {
    if (esRef.current) esRef.current.close();
    const es = new EventSource("/api/stream");
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === "new_message") {
          // Add to notifications list immediately
          const notif = {
            id:                payload.notif_id || crypto.randomUUID(),
            sender_actor_id:   payload.sender_id,
            sender_name:       payload.sender_name,
            sender_actor_type: payload.sender_actor_type,
            content:           payload.content,
            app_id:            payload.app_id || null,
            conv_type:         payload.conv_type || "text_thread",
            has_app:           payload.has_app !== false,
            read_at:           null,
            inserted_at:       payload.sent_at || new Date().toISOString(),
          };
          setNotifications(prev => {
            if (prev.find(n => n.id === notif.id)) return prev;
            return [notif, ...prev];
          });
          // Suppress toast if this conversation is already open
          const currentUrl = window.location.href;
          const alreadyOpen = currentUrl.includes(`contact=${payload.sender_id}`);
          if (!alreadyOpen) {
            showToast(notif);
          }
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
    setNotifications(prev => prev.filter(n => n.id !== id));
  }

  async function clearAll() {
    await fetch("/api/notifications", { method: "DELETE" }).catch(() => {});
    setNotifications([]);
  }

  function openFromNotif(notif) {
    markRead(notif.id);
    setShowCentre(false);

    // No app installed — open wizard pre-selecting the right tool type
    if (!notif.has_app) {
      const toolType = CONV_TO_TOOL[notif.conversation_type] || "messages";
      if (toolType === 'messages') { window.location.href = `/home?install=${toolType}`; } else { alert(toolType.charAt(0).toUpperCase() + toolType.slice(1) + ' app coming soon.'); }
      return;
    }

    const appId = notif.app_id;
    const contactParam = notif.sender_actor_id ? `&contact=${notif.sender_actor_id}` : "";
    if (appId) {
      window.open(`/messages?app=${appId}${contactParam}`, "_blank");
    } else {
      fetch("/api/apps")
        .then(r => r.ok ? r.json() : [])
        .then(apps => {
          const toolType = CONV_TO_TOOL[notif.conversation_type] || "messages";
          const app = apps.find(a => a.tool_type === toolType);
          if (app) window.open(`/messages?app=${app.id}${contactParam}`, "_blank");
          else if (toolType === 'messages') { window.location.href = `/home?install=${toolType}`; } else { alert(toolType.charAt(0).toUpperCase() + toolType.slice(1) + ' app coming soon.'); }
        });
    }
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
        <Route path="/login"  element={<LoginPage />} />
        <Route path="/enroll" element={<EnrollPage />} />
        <Route path="*"       element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <>
      <Routes>
        <Route path="/home"         element={<HomePage />} />
        <Route path="/my-worlds"    element={<WorldsPage />} />
        <Route path="/developer"    element={<DeveloperPage />} />
        <Route path="/messages"     element={<MessagesPage />} />
        <Route path="/calendar"     element={<CalendarPage />} />
        <Route path="/voicemail"    element={<VoicemailPage />} />
        <Route path="/actors"            element={<ActorsGalleryPage />} />
        <Route path="/actors/:id"        element={<ActorsEditorPage />} />
        <Route path="/actors/:id/deploy" element={<DeployWizardPage />} />
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

      <style>{`
        @keyframes ncSlide { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes toastIn { from { transform: translateX(120%); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
      `}</style>
    </>
  );
}


function NotifItem({ notif, onOpen, onClear }) {
  const [hover, setHover] = useState(false);
  const hasApp = notif.has_app !== false;
  const toolType = CONV_TO_TOOL[notif.conversation_type] || "messages";
  const toolMeta = TOOL_LABELS[toolType] || TOOL_LABELS.messages;

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
        {initials(notif.sender_name)}
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:2}}>
          <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,fontWeight:500,color:"#1a1814"}}>{notif.sender_name}</span>
          <TypeBadge convType={notif.conversation_type} />
          <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,color:"#a8a5a0",marginLeft:"auto"}}>{formatTime(notif.inserted_at)}</span>
        </div>
        {hasApp ? (
          <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:"#6b6760",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",margin:0}}>{notif.content}</p>
        ) : notif.conversation_type === "call_request" ? (
          <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:toolMeta.color,margin:0}}>
            Missed call — Install Voice Call app to answer calls →
          </p>
        ) : toolType === "voice" ? (
          <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:toolMeta.color,margin:0}}>
            Install Voice app to listen →
          </p>
        ) : (
          <p style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,color:toolMeta.color,margin:0}}>
            Install {toolMeta.label} app to {toolType === "email" ? "read" : "view"} →
          </p>
        )}
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
