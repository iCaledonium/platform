import { useState, useEffect, useRef } from "react";

// ── Time helpers ──────────────────────────────────────────────────────────────

function slotToMinutes(t) {
  if (!t) return 0;
  const [h, m] = t.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function isoToMinutes(iso) {
  if (!iso) return 0;
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function fmtHour(h) {
  if (h === 0)  return "12 AM";
  if (h < 12)   return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function fmtShortTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function nowMinutes() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}

function getWeekDays(offsetWeeks = 0) {
  const today  = new Date();
  const dow    = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offsetWeeks * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

// ── Activity colors — light palette matching platform ─────────────────────────

function activityColor(slug) {
  if (!slug) return { bg: "rgba(176,92,8,.1)", border: "#b05c08", text: "#7a3f00" };
  if (slug.startsWith("work_"))
    return { bg: "rgba(40,120,60,.1)", border: "#2a6e3a", text: "#1a4a26" };
  if (slug.startsWith("social_") || slug === "social_drinks" || slug === "social_bar" || slug === "social_dinner")
    return { bg: "rgba(100,60,160,.1)", border: "#6b3ca0", text: "#4a2070" };
  if (slug === "sleeping" || slug === "napping")
    return { bg: "rgba(0,0,0,.04)", border: "rgba(0,0,0,.15)", text: "#8a8780" };
  if (slug === "exercise" || slug === "running" || slug === "yoga")
    return { bg: "rgba(180,50,40,.1)", border: "#b43228", text: "#7a1a10" };
  if (slug === "coffee" || slug === "drinking_coffee" || slug === "brunch")
    return { bg: "rgba(176,92,8,.1)", border: "#b05c08", text: "#7a3f00" };
  if (slug === "reading" || slug === "studying" || slug === "creative" || slug === "exhibition")
    return { bg: "rgba(40,90,180,.1)", border: "#2850a0", text: "#1a3070" };
  if (slug === "decompressing" || slug === "relaxing" || slug === "meditation" || slug === "meditating")
    return { bg: "rgba(30,120,100,.1)", border: "#1e7864", text: "#0a4a3a" };
  return { bg: "rgba(176,92,8,.1)", border: "#b05c08", text: "#7a3f00" };
}

const MEETING_COLOR = { bg: "rgba(26,122,53,.12)", border: "#1a7a35", text: "#0d4a1e" };
const DAY_NAMES     = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

// ── Component ─────────────────────────────────────────────────────────────────

export default function CalendarPage() {
  const params = new URLSearchParams(window.location.search);
  const appId  = params.get("app");

  const [appName, setAppName]         = useState("Calendar");
  const [calendar, setCalendar]       = useState(null);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [weekOffset, setWeekOffset]   = useState(0);
  const [selectedDay, setSelectedDay] = useState(new Date());
  const gridRef = useRef(null);

  const HOUR_HEIGHT = 52;

  useEffect(() => {
    fetch("/api/me")
      .then(r => r.ok ? r.json() : null)
      .then(me => {
        if (!me) { window.location.href = "/login"; return; }
        if (appId) {
          fetch("/api/apps")
            .then(r => r.ok ? r.json() : [])
            .then(apps => {
              const app = apps.find(a => a.id === appId);
              const src = app || me.worlds?.[0];
              if (src) {
                if (app?.name) { setAppName(app.name); document.title = app.name; }
                loadCalendar(src.world_id, src.actor_id || me.worlds?.[0]?.actor_id);
              } else setError("No world found.");
            });
        } else {
          const w = me.worlds?.[0];
          if (w) loadCalendar(w.world_id, w.actor_id);
          else setError("No world found.");
        }
      });
  }, []);

  useEffect(() => {
    if (!loading && gridRef.current) {
      gridRef.current.scrollTop = 7 * HOUR_HEIGHT;
    }
  }, [loading]);

  function loadCalendar(wId, aId) {
    setLoading(true);
    fetch(`/api/worlds/${wId}/actors/${aId}/calendar`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        setCalendar(data || null);
        if (!data) setError("Could not load calendar.");
        setLoading(false);
      })
      .catch(() => { setError("Simulator unreachable."); setLoading(false); });
  }

  const weekDays   = getWeekDays(weekOffset);
  const today      = new Date();
  const monthLabel = [...new Set(
    weekDays.map(d => d.toLocaleDateString("en-US", { month: "long", year: "numeric" }))
  )].join(" – ");

  const meetingsByDay = {};
  (calendar?.planned_meetings || []).forEach(m => {
    const d   = new Date(m.scheduled_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!meetingsByDay[key]) meetingsByDay[key] = [];
    meetingsByDay[key].push(m);
  });

  const todaySlots = calendar?.today_slots || [];

  // ── States ────────────────────────────────────────────────────────────────

  const glassPanel = {
    background: "rgba(255,255,255,.6)",
    backdropFilter: "blur(40px)",
    WebkitBackdropFilter: "blur(40px)",
  };

  if (loading) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#eeecea", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 24, height: 24, border: "2px solid #b05c08", borderTopColor: "transparent", borderRadius: "50%", animation: "spin .8s linear infinite", margin: "0 auto 12px" }} />
        <p style={{ color: "#a8a5a0", fontSize: 11, letterSpacing: ".08em" }}>Loading</p>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  if (error) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#eeecea" }}>
      <p style={{ color: "#b43228", fontSize: 13, fontFamily: "'DM Sans', system-ui, sans-serif" }}>{error}</p>
    </div>
  );

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#eeecea", fontFamily: "'DM Sans', system-ui, sans-serif", overflow: "hidden", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500&family=DM+Sans:wght@300;400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(0,0,0,.1); border-radius: 2px; }
        .slot-ev { transition: filter .12s; cursor: default; }
        .slot-ev:hover { filter: brightness(.95); }
        .wk-day:hover { background: rgba(255,255,255,.4) !important; }
        .nav-btn:hover { background: rgba(255,255,255,.8) !important; }
        .day-col:hover { background: rgba(255,255,255,.15) !important; }
      `}</style>

      {/* Gradient overlay — same as MessagesPage */}
      <div style={{ position: "fixed", inset: 0, background: `radial-gradient(ellipse at 12% 18%, rgba(230,180,100,.22) 0%, transparent 45%), radial-gradient(ellipse at 88% 78%, rgba(160,185,230,.18) 0%, transparent 45%)`, pointerEvents: "none", zIndex: 0 }} />

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div style={{ ...glassPanel, position: "relative", zIndex: 1, height: 54, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", borderBottom: "1px solid rgba(255,255,255,.8)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <a href="/home" style={{ fontFamily: "'DM Sans', system-ui, sans-serif", fontSize: 11, color: "#a8a5a0", textDecoration: "none", letterSpacing: ".04em" }}>← Home</a>
          <span style={{ color: "rgba(0,0,0,.1)" }}>|</span>
          <span style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 20, fontWeight: 500, color: "#1a1814", letterSpacing: ".01em" }}>{appName}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="nav-btn" onClick={() => setWeekOffset(w => w - 1)} style={{ background: "rgba(255,255,255,.5)", border: "1px solid rgba(0,0,0,.08)", color: "#6b6760", borderRadius: 6, width: 28, height: 28, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", transition: "background .12s" }}>‹</button>
          <button onClick={() => { setWeekOffset(0); setSelectedDay(new Date()); }} style={{ background: weekOffset === 0 ? "rgba(176,92,8,.12)" : "rgba(255,255,255,.5)", border: `1px solid ${weekOffset === 0 ? "rgba(176,92,8,.3)" : "rgba(0,0,0,.08)"}`, color: weekOffset === 0 ? "#b05c08" : "#6b6760", borderRadius: 6, padding: "0 14px", height: 28, cursor: "pointer", fontSize: 11, fontWeight: 600, letterSpacing: ".05em", fontFamily: "inherit" }}>Today</button>
          <button className="nav-btn" onClick={() => setWeekOffset(w => w + 1)} style={{ background: "rgba(255,255,255,.5)", border: "1px solid rgba(0,0,0,.08)", color: "#6b6760", borderRadius: 6, width: 28, height: 28, cursor: "pointer", fontSize: 13, display: "flex", alignItems: "center", justifyContent: "center", transition: "background .12s" }}>›</button>
          <span style={{ fontSize: 12, color: "#a8a5a0", minWidth: 200, textAlign: "center" }}>{monthLabel}</span>
        </div>
      </div>

      {/* ── Week strip ────────────────────────────────────────────────────── */}
      <div style={{ ...glassPanel, position: "relative", zIndex: 1, display: "flex", borderBottom: "1px solid rgba(255,255,255,.8)", flexShrink: 0 }}>
        <div style={{ width: 52, flexShrink: 0 }} />
        {weekDays.map((day, i) => {
          const isToday = isSameDay(day, today);
          const isSel   = isSameDay(day, selectedDay);
          const dayKey  = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
          const hasMtg  = !!meetingsByDay[dayKey]?.length;
          const hasSlt  = isSameDay(day, today) && todaySlots.length > 0;
          return (
            <div key={i} className="wk-day" onClick={() => setSelectedDay(day)} style={{ flex: 1, padding: "8px 4px 7px", textAlign: "center", cursor: "pointer", borderLeft: "1px solid rgba(0,0,0,.05)", borderBottom: isSel ? "2px solid #b05c08" : "2px solid transparent", background: isSel ? "rgba(255,255,255,.4)" : "transparent", transition: "background .12s" }}>
              <div style={{ fontSize: 9, color: isToday ? "#b05c08" : "#a8a5a0", fontWeight: 600, letterSpacing: ".1em", marginBottom: 4 }}>{DAY_NAMES[i]}</div>
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: isToday ? "#1a1814" : "transparent", color: isToday ? "#fff" : "#1a1814", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: isToday ? 600 : 400, margin: "0 auto 4px" }}>
                {day.getDate()}
              </div>
              <div style={{ display: "flex", justifyContent: "center", gap: 3 }}>
                {hasSlt && <div style={{ width: 3, height: 3, borderRadius: "50%", background: "#b05c08" }} />}
                {hasMtg && <div style={{ width: 3, height: 3, borderRadius: "50%", background: "#1a7a35" }} />}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Time grid ─────────────────────────────────────────────────────── */}
      <div ref={gridRef} style={{ flex: 1, overflowY: "auto", position: "relative", zIndex: 1 }}>
        <div style={{ display: "flex", minHeight: 24 * HOUR_HEIGHT }}>

          {/* Hour labels */}
          <div style={{ width: 52, flexShrink: 0 }}>
            {Array.from({ length: 24 }, (_, i) => (
              <div key={i} style={{ height: HOUR_HEIGHT, display: "flex", alignItems: "flex-start", justifyContent: "flex-end", paddingRight: 10, paddingTop: 3 }}>
                {i > 0 && <span style={{ fontSize: 9, color: "#c8c5c0", whiteSpace: "nowrap", letterSpacing: ".04em", fontWeight: 500 }}>{fmtHour(i)}</span>}
              </div>
            ))}
          </div>

          {/* Day columns */}
          {weekDays.map((day, ci) => {
            const isToday = isSameDay(day, today);
            const dayKey  = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
            const dayMtgs = meetingsByDay[dayKey] || [];
            const slots   = isToday ? todaySlots : [];
            const curMin  = weekOffset === 0 && isToday ? nowMinutes() : -1;

            return (
              <div key={ci} className="day-col" style={{ flex: 1, borderLeft: "1px solid rgba(0,0,0,.05)", position: "relative", transition: "background .12s" }}>
                {/* Hour lines */}
                {Array.from({ length: 24 }, (_, i) => (
                  <div key={i} style={{ position: "absolute", top: i * HOUR_HEIGHT, left: 0, right: 0, borderTop: i === 0 ? "none" : "1px solid rgba(0,0,0,.05)", height: HOUR_HEIGHT }} />
                ))}
                {/* Half-hour lines */}
                {Array.from({ length: 24 }, (_, i) => (
                  <div key={`h${i}`} style={{ position: "absolute", top: i * HOUR_HEIGHT + HOUR_HEIGHT / 2, left: 0, right: 0, borderTop: "1px solid rgba(0,0,0,.025)" }} />
                ))}

                {/* Today tint */}
                {isToday && <div style={{ position: "absolute", inset: 0, background: "rgba(176,92,8,.03)", pointerEvents: "none" }} />}

                {/* Now line */}
                {curMin >= 0 && (
                  <div style={{ position: "absolute", top: (curMin / 60) * HOUR_HEIGHT, left: 0, right: 0, zIndex: 10, pointerEvents: "none" }}>
                    <div style={{ position: "absolute", left: -4, top: -4, width: 8, height: 8, borderRadius: "50%", background: "#b05c08" }} />
                    <div style={{ borderTop: "1.5px solid #b05c08", marginLeft: 4 }} />
                  </div>
                )}

                {/* Schedule slots */}
                {slots.map((slot, si) => {
                  const top    = (slotToMinutes(slot.start) / 60) * HOUR_HEIGHT;
                  const height = Math.max(((slotToMinutes(slot.end) - slotToMinutes(slot.start)) / 60) * HOUR_HEIGHT - 2, 20);
                  const col    = activityColor(slot.activity_slug);
                  const label  = (slot.activity_slug || "—").replace(/_/g, " ");
                  return (
                    <div key={si} className="slot-ev" style={{ position: "absolute", top: top + 1, left: 2, right: 2, height, background: col.bg, borderLeft: `2px solid ${col.border}`, borderRadius: 4, padding: "3px 7px", overflow: "hidden", zIndex: 2 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: col.text, textTransform: "capitalize", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                      {height > 30 && <div style={{ fontSize: 9, color: col.text, opacity: .6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{slot.start?.slice(0, 5)} – {slot.end?.slice(0, 5)}{slot.state_note ? ` · ${slot.state_note}` : ""}</div>}
                    </div>
                  );
                })}

                {/* Meetings */}
                {dayMtgs.map((m, mi) => {
                  const top    = (isoToMinutes(m.scheduled_at) / 60) * HOUR_HEIGHT;
                  const height = Math.max(HOUR_HEIGHT - 2, 42);
                  return (
                    <div key={mi} className="slot-ev" style={{ position: "absolute", top: top + 1, left: 2, right: 2, height, background: MEETING_COLOR.bg, borderLeft: `2px solid ${MEETING_COLOR.border}`, borderRadius: 4, padding: "4px 7px", overflow: "hidden", zIndex: 3, boxShadow: "0 1px 6px rgba(0,0,0,.08)", isolation: "isolate" }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: MEETING_COLOR.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{m.with_name || "Meeting"}</div>
                      <div style={{ fontSize: 9, color: MEETING_COLOR.text, opacity: .65, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fmtShortTime(m.scheduled_at)} · {m.location_name || "TBD"}</div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Status bar ────────────────────────────────────────────────────── */}
      <div style={{ ...glassPanel, position: "relative", zIndex: 1, height: 30, borderTop: "1px solid rgba(255,255,255,.8)", display: "flex", alignItems: "center", padding: "0 20px", gap: 20, flexShrink: 0 }}>
        <span style={{ fontSize: 10, color: "#a8a5a0", letterSpacing: ".04em" }}>{todaySlots.length} slots today</span>
        {(calendar?.planned_meetings?.length || 0) > 0 && (
          <span style={{ fontSize: 10, color: "#1a7a35", fontWeight: 600 }}>● {calendar.planned_meetings.length} upcoming {calendar.planned_meetings.length > 1 ? "meetings" : "meeting"}</span>
        )}
        <span style={{ fontSize: 10, color: "#c8c5c0", marginLeft: "auto" }}>
          {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
        </span>
      </div>
    </div>
  );
}
