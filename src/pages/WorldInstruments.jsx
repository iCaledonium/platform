import { useState, useEffect, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import styles from "./WorldInstruments.module.css";

// ── WorldInstruments ─────────────────────────────────────────────────────────
//
// Session 151 — the world page absorbing what MONITOR was for.
//
// MONITOR opens anima.simulator.ngrok.dev in a new tab: a 277 KB LiveView with
// its own tab structure, its own vocabulary, and no idea who is looking at it.
// Everything it shows that the platform lacked was one missing endpoint away —
// /api/worlds/:id/runtime, added this session — so rather than porting the view,
// the world page grows instruments.
//
// The map is the ground. Each instrument is a panel you open onto it, move, and
// close; which ones you have open IS your view of the world. Layout lives in
// ?w= so a view can be linked and reloaded into, the same reason Enter became a
// route in Session 150.
//
// Two rules decide what a panel may show, and neither is enforced here — the UI
// only declines to ask. Vitals and Engine are owner-only and the server answers
// 403; the Pulse seal is a WHERE clause in the simulator keyed on the reader's
// own actor. A panel that renders nothing sensitive is not the same as data
// that never arrives, and this is the second kind.

const ICONS = {
  people: <><circle cx="9" cy="8" r="3.2" /><path d="M3.4 19.2a5.8 5.8 0 0 1 11.2 0" /><path d="M16.2 6.2a3 3 0 0 1 0 5.6M17.6 19.2a5.6 5.6 0 0 0-2-4" /></>,
  pulse:  <path d="M2.5 12h4l2.6-6.6 4 13.2L15.6 12h5.9" />,
  vitals: <path d="M4 20V9M9.3 20V4M14.7 20v-8M20 20v-5" />,
  engine: <><circle cx="12" cy="12" r="8.4" /><path d="M12 7.4V12l3 1.8" /></>,
  messages: <path d="M4 5.5h16v11H9.4L5 20v-3.5H4z" />,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M8 3.4v3.2M16 3.4v3.2" /></>,
  voicemail: <><circle cx="6.2" cy="14.5" r="3.4" /><circle cx="17.8" cy="14.5" r="3.4" /><path d="M6.2 11.1h11.6" /></>,
  relations: <><circle cx="6" cy="7" r="2.4" /><circle cx="18" cy="9" r="2.4" /><circle cx="11" cy="18" r="2.4" /><path d="M8 8.2l7.7 .6M7.2 9.3l3 6.4M16.6 11.1l-4 5.3" /></>,
  places: <><circle cx="10.5" cy="10.5" r="6.4" /><path d="M15.2 15.2 20.5 20.5" /></>,
};

// Session 153 — the panels that open beside the rail follow its real edge.
//
// left:116 was "rail edge 84, plus a 32px gap" written out as a constant, and
// it stopped being true the moment the rail could wrap to two columns: the
// panels then opened underneath it. --rail-right is published by the rail
// itself (see the ResizeObserver below), so these clear whatever it is now.
// The fallback is the one-column figure, for the first paint.
const BESIDE_RAIL = "calc(var(--rail-right, 84px) + 32px)";

const DEFAULT_POS = {
  people: { left: BESIDE_RAIL, top: 96 },
  pulse:  { right: 20, top: 96 },
  vitals: { left: BESIDE_RAIL, top: 420 },
  engine: { left: BESIDE_RAIL, bottom: 24 },
  messages:  { left: 434, top: 96 },
  calendar:  { left: 758, top: 96 },
  voicemail: { left: 434, bottom: 24 },
  relations: { right: 20, bottom: 24, width: 320 },
  places:    { left: BESIDE_RAIL, top: 96, width: 306 },
};

const VITAL_COLOURS = {
  energy:     "#4ade80",
  stress:     "#b05c08",
  hunger:     "#c9973a",
  sleep_debt: "#8ba3c9",
  loneliness: "#8ba3c9",
  mood:       "#4ade80",
};

// A stable colour per actor, so the same person is the same dot in Pulse as
// they are everywhere else. Hash rather than index: the roster reorders as
// people move, and a colour that shifts under you is worse than no colour.
const DOT_HUES = ["#b05c08", "#c9973a", "#8ba3c9", "#4ade80", "#a8a5a0"];
function hueFor(id) {
  if (!id) return "#a8a5a0";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOT_HUES[h % DOT_HUES.length];
}

const initials = name => (name || "?").split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase();

function clock(iso) {
  if (!iso) return "—";
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  if (isNaN(d)) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── one draggable panel ──────────────────────────────────────────────────────
function Panel({ id, title, count, owner, onClose, children, width }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  // Session 153 — null until the user resizes; after that the panel is the
  // size they chose and stops sizing itself to its contents.
  const [size, setSize] = useState(null);

  const onGrab = e => {
    if (e.target.closest("button")) return;
    const el = ref.current;
    const r  = el.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = ev => setPos({
      left: Math.max(8, Math.min(window.innerWidth  - r.width - 8, ev.clientX - dx)),
      top:  Math.max(8, Math.min(window.innerHeight - 56,          ev.clientY - dy)),
    });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Session 153 — drag the corner to resize.
  //
  // Hand-rolled rather than CSS `resize: both` because the default size has to
  // stay content-driven: the body carries a 300px cap so a panel opens at the
  // height of what is in it, and CSS resize cannot lift that cap only once the
  // user has taken over. Here the cap is dropped by a class the moment a size
  // exists, so the list grows into the space instead of leaving it blank.
  const onResize = e => {
    e.preventDefault();
    e.stopPropagation();          // never let the header's drag see this
    const el = ref.current;
    const r  = el.getBoundingClientRect();
    // Panels anchored by right/bottom (Pulse, Engine) would otherwise grow
    // away from the corner being dragged. Pin to left/top first so every
    // panel grows toward the pointer.
    if (!pos) setPos({ left: Math.round(r.left), top: Math.round(r.top) });
    const x0 = e.clientX, y0 = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const move = ev => setSize({
      w: Math.max(240, Math.min(window.innerWidth  - r.left - 8, r.width  + (ev.clientX - x0))),
      h: Math.max(140, Math.min(window.innerHeight - r.top  - 8, r.height + (ev.clientY - y0))),
    });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <section ref={ref} className={`${styles.w}${size ? " " + styles.wSized : ""}`}
      style={{ ...(pos || DEFAULT_POS[id]), ...(width ? { width } : {}),
               ...(size ? { width: size.w, height: size.h } : {}) }}>
      <header className={styles.whd} onPointerDown={onGrab}>
        <span className={styles.wttl}>{title}</span>
        {count != null && <span className={styles.wcnt}>{count}</span>}
        {owner && <span className={styles.wown}>Owner</span>}
        <button className={styles.wx} onClick={onClose} aria-label={`Close ${title}`}>✕</button>
      </header>
      {children}
      <div className={styles.wrz} onPointerDown={onResize} aria-hidden="true" />
    </section>
  );
}

// ── the layer ────────────────────────────────────────────────────────────────
export default function WorldInstruments({ world, playerActorId }) {
  const isOwner = world?.role === "owner";
  const worldId = world?.id;

  const [params, setParams] = useSearchParams();
  const [runtime, setRuntime] = useState(null);   // owner only — 403 otherwise
  const [presence, setPresence] = useState(null); // everyone
  const [feed, setFeed] = useState([]);
  const [sel, setSel] = useState(null);
  const [ticking, setTicking] = useState(false);

  const [query, setQuery]         = useState("");

  // Session 153 — publish how far right the rail actually reaches.
  //
  // The rail's width is not a constant: it is one column normally and two when
  // it wraps to keep the Owner group on screen. Anything else drawn in that
  // corner has to clear whichever it currently is. Hard-coding the offset has
  // now put the weather chip under the rail twice — once at 64px wide, again
  // at 111 — so the rail states its own edge and the map reads it, instead of
  // a third guess that the next layout change invalidates.
  const railRef = useRef(null);
  useEffect(() => {
    const el = railRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const publish = () => document.documentElement.style.setProperty(
      "--rail-right", `${Math.round(el.getBoundingClientRect().right)}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", publish);
      document.documentElement.style.removeProperty("--rail-right");
    };
  }, []);
  const [relations, setRelations] = useState(null);
  const [comms, setComms]         = useState(null);   // whoever is being read
  const [thread, setThread]       = useState(null);  // {id, name}
  const [threadMsgs, setThreadMsgs] = useState([]);
  const [draft, setDraft]         = useState("");
  const [sending, setSending]     = useState(false);

  const INSTRUMENTS = [
    { key: "people",    label: "People",    group: "World", owner: false },
    { key: "pulse",     label: "Pulse",     group: "World", owner: false },
    { key: "places",    label: "Places",    group: "World", owner: false },
    { key: "relations", label: "Relations", group: "World", owner: false },
    { key: "messages",  label: "Messages",  group: "Comms", owner: false },
    { key: "calendar",  label: "Calendar",  group: "Comms", owner: false },
    { key: "voicemail", label: "Voicemail", group: "Comms", owner: false },
    { key: "vitals",    label: "Vitals",    group: "Owner", owner: true  },
    { key: "engine",    label: "Engine",    group: "Owner", owner: true  },
  ].filter(i => !i.owner || isOwner);

  // Which panels are open lives in the URL, so a view can be sent to someone.
  const openSet = (() => {
    const raw = params.get("w");
    if (raw !== null) return new Set(raw ? raw.split(",") : []);
    return new Set(isOwner ? ["people", "pulse"] : ["people", "pulse"]);
  })();
  const isOpen = k => openSet.has(k);
  const toggle = k => {
    const next = new Set(openSet);
    next.has(k) ? next.delete(k) : next.add(k);
    const p = new URLSearchParams(params);
    p.set("w", [...next].join(","));
    setParams(p, { replace: true });
  };

  const loadRuntime = useCallback(() => {
    if (!isOwner || !worldId) return;
    fetch(`/api/worlds/${worldId}/runtime`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setRuntime(d); })
      .catch(() => {});
  }, [isOwner, worldId]);

  const loadFeed = useCallback(() => {
    if (!worldId) return;
    fetch(`/api/worlds/${worldId}/feed?limit=60`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.entries) setFeed(d.entries); })
      .catch(() => {});
  }, [worldId]);

  const loadRelations = useCallback(() => {
    if (!worldId) return;
    fetch(`/api/worlds/${worldId}/relations`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setRelations(d); })
      .catch(() => {});
  }, [worldId]);

  // Session 151 — presence used to be fetched only for players, because People
  // read runtime for owners. Places needs the venue list whoever is asking.
  const loadPresence = useCallback(() => {
    if (!worldId) return;
    fetch(`/api/worlds/${worldId}/presence`, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setPresence(d); })
      .catch(() => {});
  }, [worldId]);

  useEffect(() => {
    loadRuntime(); loadFeed(); loadPresence(); loadRelations();
    const t = setInterval(() => { loadRuntime(); loadFeed(); loadPresence(); loadRelations(); }, 15000);
    return () => clearInterval(t);
  }, [loadRuntime, loadFeed, loadPresence, loadRelations]);

  // ── roster ─────────────────────────────────────────────────────────────────
  // Owner reads runtime, which knows how everyone is. A player reads presence,
  // which knows only where the visible ones are — and that difference is the
  // permission, not a rendering choice.
  const people = (() => {
    if (isOwner && runtime?.actors) {
      return runtime.actors.map(a => ({
        id: a.id, name: a.name, sub: a.occupation, isPlayer: a.actor_type === "user",
        awake: a.alive && !a.sleeping, portrait: a.portrait_url,
        doing: a.doing || a.situation || a.location_name ||
               (a.transit ? `In transit — ${a.transit.destination_name || "somewhere"}` : "—"),
        need: a.need, raw: a,
      }));
    }
    const locs = presence?.locations || [];
    const out = [];
    for (const l of locs) {
      for (const a of (l.actors || [])) {
        if (a.is_ambient) continue;
        out.push({
          id: a.actor_id, name: a.name, sub: a.occupation, isPlayer: false,
          awake: true, portrait: a.generated_portrait_url || a.photo_url,
          doing: a.in_transit ? "In transit" : l.name, need: null, raw: a,
        });
      }
    }
    return out;
  })();

  const selected = isOwner && runtime?.actors
    ? runtime.actors.find(a => a.id === sel) || null
    : null;

  // ── whose correspondence is on screen ──────────────────────────────────────
  //
  // A player reads their own phone, always. An owner reads whoever is selected
  // in People — which is the same gesture that drives Vitals, so one click moves
  // every panel to the same person. Selecting nobody, or selecting yourself,
  // means your own.
  const myActorId = world?.actor_id || null;
  const selectedActor = runtime?.actors?.find(a => a.id === sel) || null;
  const readingCast = isOwner && selectedActor && selectedActor.actor_type !== "user";
  const readingOtherPlayer = isOwner && selectedActor && selectedActor.actor_type === "user"
                             && selectedActor.id !== myActorId;
  const subjectId   = readingCast ? selectedActor.id : myActorId;
  const subjectName = readingCast ? selectedActor.name : "you";

  useEffect(() => {
    setThread(null); setThreadMsgs([]);
    if (readingOtherPlayer || !subjectId) { setComms(null); return; }
    let dead = false;

    if (readingCast) {
      fetch(`/api/worlds/${worldId}/cast/${subjectId}/comms`, { credentials: "include" })
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (!dead && d) setComms({
          contacts: d.contacts || [], sealedContacts: d.sealed_contacts || 0,
          voicemail: d.voicemail || [], sealedVoicemail: d.sealed_voicemail || 0,
          calendar: d.calendar || [], canWrite: false,
        }); })
        .catch(() => {});
    } else {
      // Your own phone, through the routes the Messages page already uses.
      Promise.all([
        fetch(`/api/worlds/${worldId}/actors/${subjectId}/contacts`,  { credentials: "include" }).then(r => r.ok ? r.json() : []),
        fetch(`/api/worlds/${worldId}/actors/${subjectId}/voicemail`, { credentials: "include" }).then(r => r.ok ? r.json() : []),
        fetch(`/api/worlds/${worldId}/actors/${subjectId}/calendar`,  { credentials: "include" }).then(r => r.ok ? r.json() : {}),
      ]).then(([contacts, vm, cal]) => {
        if (dead) return;
        setComms({
          contacts: Array.isArray(contacts) ? contacts : [],
          sealedContacts: 0,
          voicemail: Array.isArray(vm) ? vm : [],
          sealedVoicemail: 0,
          calendar: (cal?.planned_meetings || []).map(m => ({
            id: m.id, with_name: m.with_name, with_private: false,
            location_name: m.location_name, scheduled_at: m.scheduled_at, status: m.status,
          })),
          canWrite: true,
        });
      }).catch(() => {});
    }
    return () => { dead = true; };
  }, [worldId, subjectId, readingCast, readingOtherPlayer]);

  const openThread = c => {
    setThread(c); setThreadMsgs([]);
    const url = readingCast
      ? `/api/worlds/${worldId}/cast/${subjectId}/thread/${c.id}`
      : `/api/worlds/${worldId}/actors/${subjectId}/messages/${c.id}`;
    fetch(url, { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(d => setThreadMsgs(Array.isArray(d) ? d : (d?.messages || [])))
      .catch(() => {});
  };

  const sendDraft = async () => {
    if (!draft.trim() || !thread || !comms?.canWrite) return;
    setSending(true);
    try {
      await fetch(`/api/worlds/${worldId}/actors/${subjectId}/messages/${thread.id}`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft.trim() }),
      });
      setDraft("");
      openThread(thread);
    } finally { setSending(false); }
  };

  const commsHeader = () => isOwner ? (
    <div className={styles.subj}>
      Reading <b>{readingCast ? `${subjectName}'s` : "your own"}</b>
      {readingCast && <span className={styles.ro}>read only</span>}
    </div>
  ) : null;

  const playerBarrier = (
    <div className={styles.barrier}>
      <b>{selectedActor?.name} is a player.</b> Their correspondence is theirs. You can read the
      cast you wrote, never another player.
    </div>
  );

  const sealedNote = (n, what) => n > 0 ? (
    <div className={styles.sealed}>
      <b>{n} sealed.</b> {n === 1 ? "A conversation" : "Conversations"} between {subjectName} and
      a user {n === 1 ? "belongs" : "belong"} to that user — not yours to read, even here.
    </div>
  ) : null;

  // ── Places ─────────────────────────────────────────────────────────────────
  //
  // Eighty-six locations, and since the quiet tier only labels rooms with people
  // in them, finding a particular café means reading eighty-four identical dots.
  // Search is the missing half of that trade: the map stays legible, and you can
  // still ask where something is.
  //
  // Matching folds diacritics, so "Rosteriet" finds "Café Rosteriet" and typing
  // "hemma" finds it whichever way you spell the a.
  const fold = t => (t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  const places = (() => {
    const all = (presence?.locations || []).map(l => {
      const people = (l.actors || []);
      const cast = people.filter(a => !a.is_ambient);
      // Session 151 — the count is a headcount, so it counts heads.
      //
      // It used to be named people only, which meant Rio read "1" with
      // twenty-five people watching a film in it. The crowd is most of who is
      // in a room; leaving it out made the number answer a question nobody was
      // asking. Cast still decides the colour — how busy a place is and whether
      // somebody you know is in it are two different things, and the badge can
      // carry both.
      const crowd = l.crowd_size || 0;
      return { loc: l, name: l.name || "Unnamed", category: l.category || "",
               area: l.area || "", people: people.length, cast: cast.length,
               crowd, total: people.length + crowd,
               detail: [
                 cast.length && `${cast.length} you can meet`,
                 (people.length - cast.length) && `${people.length - cast.length} staff or regulars`,
                 crowd && `${crowd} in the crowd`,
               ].filter(Boolean).join(" · "),
             };
    });
    const q = fold(query.trim());
    const hits = q
      ? all.filter(p => fold(p.name).includes(q) || fold(p.category).includes(q) || fold(p.area).includes(q))
      : all;
    // Somewhere with people in it is a more useful answer than somewhere empty.
    return hits.sort((a, b) =>
      (b.cast - a.cast) || (b.total - a.total) || a.name.localeCompare(b.name, "sv"));
  })();

  // Session 153 — a click in a panel takes the map there.
  //
  // Both of these were selection-only: Places panned without going in close,
  // People did not move the map at all. Picking a name out of a list is an
  // ask to be shown where they are, so both now centre and zoom to street
  // level. The overlay owns the map and decides how far in — see FOCUS_ZOOM.
  const goToPlace = p => {
    if (window.__animaSelectLocation) window.__animaSelectLocation(p.loc, { focus: true });
  };

  // Selection still stands on its own: Vitals and Comms follow `sel` whether or
  // not the map could place them, so the focus is an addition to that click and
  // never a precondition for it.
  const goToPerson = p => {
    setSel(p.id);
    window.__animaFocusActor?.(p.id);
  };

  const forceTick = async () => {
    setTicking(true);
    try {
      await fetch(`/api/worlds/${worldId}/tick`, { method: "POST", credentials: "include" });
      setTimeout(() => { loadRuntime(); loadFeed(); }, 1200);
    } finally { setTicking(false); }
  };

  if (!world) return null;

  const lastTick = runtime?.actors
    ?.map(a => a.engine?.ticked_at).filter(Boolean).sort().pop();

  return (
    <>
      <nav ref={railRef} className={styles.rail} aria-label="Instruments">
        {["World", "Comms", "Owner"]
          .filter(g => INSTRUMENTS.some(i => i.group === g))
          .map(g => (
            <div key={g}>
              <div className={styles.railcap}>{g}</div>
              {INSTRUMENTS.filter(i => i.group === g).map(i => (
                <RailButton key={i.key} i={i} on={isOpen(i.key)} onClick={() => toggle(i.key)} />
              ))}
            </div>
          ))}
      </nav>

      {isOpen("people") && (
        <Panel id="people" title="People" count={people.length} onClose={() => toggle("people")}>
          <div className={styles.wbd}>
            {people.length === 0 && (
              <p className={styles.empty}>
                {isOwner ? "No actors in this world yet." : "Nobody you can see is out right now."}
              </p>
            )}
            {people.map(p => (
              <div key={p.id}
                className={`${styles.row} ${sel === p.id ? styles.rowOn : ""}`}
                onClick={() => goToPerson(p)}>
                <div className={styles.face}>
                  {initials(p.name)}
                  {p.portrait && <img className={styles.facePhoto} src={p.portrait} alt=""
                    onError={e => { e.target.style.display = "none"; }} />}
                  <span className={`${styles.awake} ${p.awake ? "" : styles.asleep}`} />
                </div>
                <div className={styles.who}>
                  <div className={styles.nm}>{p.name}</div>
                  <div className={styles.doing}>{p.doing}</div>
                </div>
                {p.isPlayer
                  ? <span className={styles.tagp}>player</span>
                  : p.need
                    ? <span className={styles.need}>{p.need.type}</span>
                    : isOwner ? <span className={`${styles.need} ${styles.needQuiet}`}>steady</span> : null}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {isOpen("pulse") && (
        <Panel id="pulse" title="Pulse" count={feed.length} width={340} onClose={() => toggle("pulse")}>
          <div className={styles.wbd}>
            {feed.length === 0 && <p className={styles.empty}>Nothing has happened yet today.</p>}
            {feed.map(e => (
              <div key={e.id} className={styles.ev}>
                <time className={styles.evTime}>{clock(e.at)}</time>
                <span className={styles.evDot} style={{ background: hueFor(e.actor_id) }} />
                <p className={styles.evText}>
                  {/* Most entries are written as full sentences that already name
                      the actor ("Lindsey Vaughn responded to Magnus Klack"), and a
                      few are bare ("scrolling through her phone"). Prefixing
                      unconditionally said the name twice. */}
                  {e.actor_name && !(e.content || "").startsWith(e.actor_name) && <b>{e.actor_name} </b>}
                  {e.content}
                  {e.visibility === "private" && <span className={styles.evPrivate}>yours</span>}
                </p>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {isOpen("places") && (
        <Panel id="places" title="Places" count={places.length} width={306}
          onClose={() => toggle("places")}>
          <div className={styles.searchWrap}>
            <input className={styles.search} value={query} autoFocus
              onChange={e => setQuery(e.target.value)}
              placeholder="Find a place…" aria-label="Find a place" />
          </div>
          <div className={styles.wbd}>
            {places.length === 0 && (
              <p className={styles.empty}>
                {query ? `Nowhere called “${query}”.` : "No places in this world yet."}
              </p>
            )}
            {places.map(p => (
              <div key={p.loc.id} className={styles.placeRow} onClick={() => goToPlace(p)}>
                <span className={`${styles.placeDot} ${p.total ? styles.placeDotLively : ""}`} />
                <div className={styles.placeMain}>
                  <div className={styles.placeName}>{p.name}</div>
                  <div className={styles.placeMeta}>
                    {[p.category.replace(/_/g, " "), p.area].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
                {p.total > 0 && (
                  <span className={`${styles.placeCount} ${p.cast ? styles.placeCountCast : ""}`}
                    title={p.detail}>
                    {p.total}
                  </span>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {isOpen("relations") && (
        <Panel id="relations" title="Relations" count={relations?.edges?.length}
          width={320} onClose={() => toggle("relations")}>
          {!relations ? <p className={styles.empty}>Loading…</p>
            : relations.edges.length === 0 ? (
              <p className={styles.empty}>
                {relations.sealed_edges > 0
                  ? "Every tie in this world is between a character and a user, so none of it is yours to read."
                  : "Nobody knows anybody yet."}
              </p>
            ) : (
              <div className={styles.wbd}>
                <div className={styles.graph}>{relationGraph(relations, myActorId)}</div>
                {pairsOf(relations).map(t => (
                  <div key={t.key} className={styles.tie}>
                    <span className={styles.tieWho}>
                      {t.aName} <span style={{ color: "#c4bfb8" }}>—</span> {t.bName}
                    </span>
                    <span className={styles.tieWord}>{t.word}</span>
                    {t.trust != null && <span className={styles.tieNum}>{t.trust.toFixed(2)}</span>}
                  </div>
                ))}
                {relations.sealed_edges > 0 && (
                  <div className={styles.sealed}>
                    <b>{relations.sealed_edges} sealed.</b> Ties between a character and a user
                    belong to that user — how well they know each other is not yours to read.
                  </div>
                )}
              </div>
            )}
        </Panel>
      )}

      {isOpen("messages") && (
        <Panel id="messages" title="Messages" count={comms?.contacts?.length}
          onClose={() => toggle("messages")}>
          {readingOtherPlayer ? playerBarrier : !comms ? (
            <p className={styles.empty}>Loading…</p>
          ) : thread ? (
            <>
              <button className={styles.back} onClick={() => setThread(null)}>← {thread.name}</button>
              <div className={styles.wbd}>
                <div className={styles.convo}>
                  {threadMsgs.length === 0 && <p className={styles.empty}>No messages in this thread.</p>}
                  {threadMsgs.map(m => (
                    <div key={m.id} style={{ display: "contents" }}>
                      <div className={`${styles.msg} ${m.from_me ? styles.msgOut : styles.msgIn}`}>{m.content}</div>
                      <span className={styles.msgt}>{clock(m.sent_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
              {comms.canWrite ? (
                <div className={styles.composer}>
                  <input value={draft} onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") sendDraft(); }}
                    placeholder={`Write to ${thread.name.split(" ")[0]}`} aria-label="Message" />
                  <button className={styles.send} onClick={sendDraft} disabled={sending || !draft.trim()}>
                    {sending ? "…" : "Send"}
                  </button>
                </div>
              ) : (
                <div className={styles.sealed}>
                  {subjectName.split(" ")[0]} writes her own replies. You can watch her decide in
                  Vitals — you can't speak for her.
                </div>
              )}
            </>
          ) : (
            <>
              {commsHeader()}
              <div className={styles.wbd}>
                {comms.contacts.length === 0 && (
                  <p className={styles.empty}>
                    {readingCast ? `No messages between ${subjectName.split(" ")[0]} and the rest of the cast.`
                                 : "No messages yet."}
                  </p>
                )}
                {comms.contacts.map(c => (
                  <div key={c.id} className={styles.thread} onClick={() => openThread(c)}>
                    <div className={styles.face}>{initials(c.name)}</div>
                    <div className={styles.tmid}>
                      <div className={styles.tname}>{c.name}</div>
                      <div className={styles.tprev}>{c.last_message || c.occupation || "—"}</div>
                    </div>
                    <span className={styles.twhen}>{c.last_sent_at ? clock(c.last_sent_at) : ""}</span>
                  </div>
                ))}
                {sealedNote(comms.sealedContacts)}
              </div>
            </>
          )}
        </Panel>
      )}

      {isOpen("calendar") && (
        <Panel id="calendar" title="Calendar" count={comms?.calendar?.length}
          width={324} onClose={() => toggle("calendar")}>
          {readingOtherPlayer ? playerBarrier : !comms ? (
            <p className={styles.empty}>Loading…</p>
          ) : (
            <>
              {commsHeader()}
              <div className={styles.wbd}>
                {comms.calendar.length === 0 && <p className={styles.empty}>Nothing in the diary.</p>}
                <div className={styles.agenda}>
                  {comms.calendar.map(m => (
                    <div key={m.id} className={styles.slot}>
                      <span className={styles.slott}>{clock(m.scheduled_at)}</span>
                      <div className={styles.slotc}>
                        <div className={`${styles.apt} ${m.with_private ? styles.aptPrivate : m.status === "confirmed" ? "" : styles.aptSoft}`}>
                          {m.with_private ? "Private appointment" : `With ${m.with_name}`}
                          <div className={styles.aptw}>
                            {[m.location_name, m.with_private ? "with a user" : m.status]
                              .filter(Boolean).join(" · ")}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </Panel>
      )}

      {isOpen("voicemail") && (
        <Panel id="voicemail" title="Voicemail" count={comms?.voicemail?.length}
          onClose={() => toggle("voicemail")}>
          {readingOtherPlayer ? playerBarrier : !comms ? (
            <p className={styles.empty}>Loading…</p>
          ) : (
            <>
              {commsHeader()}
              <div className={styles.wbd}>
                {comms.voicemail.length === 0 && <p className={styles.empty}>No voicemail.</p>}
                {comms.voicemail.map(v => (
                  <div key={v.id} className={styles.vm}>
                    <button className={styles.play} aria-label={`Play message from ${v.sender_name}`}>
                      <svg viewBox="0 0 10 10"><path d="M1 0l8 5-8 5z" /></svg>
                    </button>
                    <div className={styles.tmid}>
                      <div className={styles.tname}>
                        {v.sender_name}{!v.read_at && <span className={styles.unread} />}
                      </div>
                      <div className={styles.tprev}>{clock(v.sent_at)}</div>
                      <div className={styles.vmt}>{v.content}</div>
                    </div>
                  </div>
                ))}
                {sealedNote(comms.sealedVoicemail)}
              </div>
            </>
          )}
        </Panel>
      )}

      {isOwner && isOpen("vitals") && (
        <Panel id="vitals" title="Vitals" owner onClose={() => toggle("vitals")}>
          {!selected ? (
            <p className={styles.empty}>Pick someone in People to see how they are.</p>
          ) : selected.actor_type === "user" ? (
            <div className={styles.barrier}>
              <b>{selected.name} is a player.</b> Their character's interior belongs to them —
              you own the world, not the people playing in it.
            </div>
          ) : (
            <div className={styles.vt}>
              <div className={styles.vhead}>
                <span className={styles.vname}>{selected.name}</span>
                <span className={styles.vrole}>{selected.occupation}</span>
              </div>
              {["energy", "stress", "hunger", "sleep_debt", "loneliness"].map(k => {
                const v = selected.vitals?.[k];
                if (v == null) return null;
                return (
                  <div key={k} className={styles.bar}>
                    <div className={styles.blab}>
                      <span className={styles.blabName}>{k.replace("_", " ")}</span>
                      <span className={styles.blabVal}>{Number(v).toFixed(2)}</span>
                    </div>
                    <div className={styles.btrk}>
                      <div className={styles.bfil}
                        style={{ width: `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`,
                                 background: VITAL_COLOURS[k] || "#a8a5a0" }} />
                    </div>
                  </div>
                );
              })}
              <div className={styles.vfoot}>
                <div className={styles.kv}>
                  <span className={styles.kvKey}>Picked</span>
                  <span className={styles.kvVal}>{selected.engine?.picked || "—"}</span>
                </div>
                <div className={styles.kv}>
                  <span className={styles.kvKey}>Last tick</span>
                  <span className={styles.kvVal}>{clock(selected.engine?.ticked_at)}</span>
                </div>
                {selected.balance_minor != null && (
                  <div className={styles.kv}>
                    <span className={styles.kvKey}>Balance</span>
                    <span className={styles.kvVal}>
                      {(selected.balance_minor / 100).toLocaleString("sv-SE", { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                )}
                {selected.need && (
                  <p className={styles.reason}>
                    {selected.need.intention || selected.need.drive ||
                     `${selected.need.type} — intensity ${Number(selected.need.intensity).toFixed(2)}`}
                  </p>
                )}
                {selected.crisis_arc && (
                  <p className={styles.reason}>{selected.crisis_arc.description}</p>
                )}
              </div>
            </div>
          )}
        </Panel>
      )}

      {isOwner && isOpen("engine") && (
        <Panel id="engine" title="Engine" owner width={262} onClose={() => toggle("engine")}>
          <div className={styles.tickw}>
            <div className={styles.dial}>
              <svg width="64" height="64" viewBox="0 0 64 64">
                <circle cx="32" cy="32" r="27" fill="none" stroke="rgba(0,0,0,.07)" strokeWidth="4" />
                <circle cx="32" cy="32" r="27" fill="none"
                  stroke={runtime?.running ? "#b05c08" : "#c4bfb8"} strokeWidth="4"
                  strokeLinecap="round" strokeDasharray="170"
                  strokeDashoffset={runtime?.running ? 0 : 120} />
              </svg>
              <div className={styles.dialnum}>{people.filter(p => p.awake).length}</div>
            </div>
            <div className={styles.tinfo}>
              <div className={styles.tlab}>{runtime?.running ? "Running" : "Stopped"}</div>
              <div className={styles.tsub}>
                {runtime?.running
                  ? `${people.filter(p => p.awake).length} awake · last tick ${clock(lastTick)}`
                  : "Nobody is ticking."}
              </div>
              <button className={styles.force} onClick={forceTick}
                disabled={!runtime?.running || ticking}>
                {ticking ? "Ticking…" : "Force tick"}
              </button>
            </div>
          </div>
        </Panel>
      )}
    </>
  );
}

// A tie is two rows in actor_relationships, one per direction. Drawn as one
// line: the pair is the fact, the direction is a detail of how it is stored.
function pairsOf(rel) {
  const byId = Object.fromEntries((rel.nodes || []).map(n => [n.id, n]));
  const seen = new Map();
  for (const e of rel.edges) {
    const key = [e.from, e.to].sort().join("|");
    const prev = seen.get(key);
    const word = e.state || e.status || e.rel_type;
    const merged = {
      key,
      a: e.from, b: e.to,
      aName: byId[e.from]?.name || "Unknown",
      bName: byId[e.to]?.name || "Unknown",
      word: (word && word !== "none" ? word : "knows of") .replace(/_/g, " "),
      trust: e.trust != null ? e.trust : (prev?.trust ?? null),
    };
    // Keep whichever side actually says something — a "none" row carries less
    // than a named one, and both exist for the same pair.
    if (!prev || (prev.word === "knows of" && merged.word !== "knows of")) seen.set(key, merged);
    else if (merged.trust != null && prev.trust == null) seen.set(key, { ...prev, trust: merged.trust });
  }
  return [...seen.values()];
}

function relationGraph(rel, myActorId) {
  const nodes = rel.nodes || [];
  const n = nodes.length;
  if (n === 0) return null;
  const W = 280, H = Math.min(190, 90 + n * 16), cx = W / 2, cy = H / 2;
  const R = Math.min(cx, cy) - 26;
  const at = i => n === 1
    ? { x: cx, y: cy }
    : { x: cx + R * Math.cos((2 * Math.PI * i) / n - Math.PI / 2),
        y: cy + R * Math.sin((2 * Math.PI * i) / n - Math.PI / 2) };
  const pos = Object.fromEntries(nodes.map((nd, i) => [nd.id, at(i)]));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: H }} aria-hidden="true">
      {pairsOf(rel).map(t => {
        const a = pos[t.a], b = pos[t.b];
        if (!a || !b) return null;
        const strong = t.trust != null ? t.trust >= 0.5 : t.word !== "knows of";
        return <line key={t.key} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
          stroke={strong ? "#c9973a" : "#c4bfb8"}
          strokeWidth={t.trust != null ? 1 + t.trust * 2.4 : 1.4}
          strokeDasharray={strong ? undefined : "3 3"} />;
      })}
      {nodes.map(nd => {
        const p = pos[nd.id];
        const me = nd.id === myActorId;
        return (
          <g key={nd.id}>
            <circle cx={p.x} cy={p.y} r="17"
              fill={me ? "#fff" : "#d5cfc8"}
              stroke={me ? "rgba(0,0,0,.22)" : "none"}
              strokeWidth={me ? 1.5 : 0}
              strokeDasharray={me ? "4 3" : undefined} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="11"
              fill={me ? "#1a1a1a" : "#666"} fontFamily="DM Sans, sans-serif">
              {me ? "You" : (nd.name || "?").split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function RailButton({ i, on, onClick }) {
  return (
    <button className={`${styles.rbtn} ${on ? styles.rbtnOn : ""}`}
      aria-pressed={on} aria-label={i.label} onClick={onClick}>
      <svg viewBox="0 0 24 24">{ICONS[i.key]}</svg>
      <span className={styles.tip}>{i.label}</span>
    </button>
  );
}
