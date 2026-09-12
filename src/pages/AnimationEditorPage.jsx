import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import InteractionStudioScene, { colorFor, PROP_TYPES } from "./InteractionStudioScene.jsx";
import InteractionActionEditor from "./InteractionActionEditor.jsx";
import { listActions, registerActions, getAction } from "../lib/bodyActions.js";
import { runScript } from "../lib/interactionScript.js";

// ── Animation Editor ─────────────────────────────────────────────────────────
//
// Session 158 — its own page, because it is its own job.
//
// It used to be a MODE of the Interaction Studio: a flag that hid the library,
// the timeline and the script column and left the editor sitting in the hole.
// Two tools sharing one screen and one set of state, where the only thing they
// have in common is that both need a body standing in a room. Magnus, 2026-09-12:
// "too confusing to have all on the same page".
//
// What it makes are LIBRARY ENTRIES — the Actions, Reactions and Poses the
// studio arranges. The studio composes; this authors the things it composes
// from. Back goes to the studio because that is where what you made gets used.
//
// The kind is CHOSEN here, never inferred. Inferring it from whichever step
// happened to be open is precisely how the Reaction library filled up with
// held shapes nobody reacts to.

const PAPER = "#eeecea";

const cardStyle = {
  background: "#fff", border: "1px solid rgba(0,0,0,.07)", borderRadius: 10,
  padding: "14px 16px",
};

const labelStyle = {
  fontSize: 9.5, letterSpacing: ".18em", textTransform: "uppercase",
  color: "#a8a5a0", margin: "0 0 8px",
};

const btn = (kind = "plain") => ({
  fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 12,
  padding: "6px 12px", borderRadius: 6, cursor: "pointer",
  border: kind === "primary" ? "1px solid rgba(176,92,8,.3)" : "1px solid rgba(0,0,0,.12)",
  background: kind === "primary" ? "rgba(176,92,8,.08)" : "#fff",
  color: kind === "primary" ? "#b05c08" : "#55524e",
});

const KIND_NOTE = {
  pose:     "Held. It clamps at its last frame and keeps applying until something replaces it.",
  action:   "A movement. It plays and releases back to rest.",
  reaction: "A movement that answers someone else's contact. Timed against the blow, not a clock.",
};

export default function AnimationEditorPage() {
  const navigate = useNavigate();

  // Which entry, and of what kind. Both come off the query string so the studio
  // can hand over an entry to edit, and so the page can be linked to directly.
  const q = new URLSearchParams(window.location.search);
  const [kind, setKind] = useState(() => (["pose", "action", "reaction"].includes(q.get("kind")) ? q.get("kind") : "pose"));
  const [slug, setSlug] = useState(() => q.get("ref") || "");
  // A room action is authored exactly like a human one — the difference is a
  // declaration on the entry, not a different editor.
  const [needsProp] = useState(() => q.get("room") === "1");

  const [castList, setCastList] = useState([]);
  const [toAdd, setToAdd]       = useState("");
  const [cast, setCast]         = useState({});
  const [rigReady, setRigReady] = useState(false);
  // Set by the editor whenever the draft has bones moved in it. Leaving with
  // this true throws the work away, so Back asks first.
  const [dirty, setDirty]       = useState(false);
  const [log, setLog]           = useState([]);
  const rigRef = useRef(null);
  const saveRef = useRef(null);
  const leavingRef = useRef(false);
  const runRef = useRef(null);

  const say = useCallback((text, tone = "note") => {
    setLog(l => [...l.slice(-30), { text, tone }]);
  }, []);

  // The scratch entry the editor edits. It is never added to any composition —
  // what gets saved is the LIBRARY ENTRY, and this is only the handle the
  // editor needs to know which one and on whom.
  const [entry, setEntry] = useState(() => ({
    id: "anim-" + Date.now(),
    kind: (["pose", "action", "reaction"].includes(q.get("kind")) ? q.get("kind") : "pose"),
    role: "a",
    action: q.get("ref") || "",
    needsProp: q.get("room") === "1",
  }));

  useEffect(() => { setEntry(e => ({ ...e, kind })); }, [kind]);

  // Who can stand in the room, and every motion already authored — the same two
  // fetches the studio makes, because the registry is shared and an editor that
  // could not see the library would offer an empty dropdown.
  useEffect(() => {
    fetch("/api/interaction-studio/cast", { credentials: "include" })
      .then(r => (r.ok ? r.json() : []))
      .then(list => {
        setCastList(list);
        const first = list.find(p => !p.unavailable);
        if (first) setCast({ a: first });
      })
      .catch(() => {});
    fetch("/api/body-interactions", { credentials: "include" })
      .then(r => (r.ok ? r.json() : []))
      .then(rows => registerActions(rows))
      .catch(() => {});
  }, []);

  const onRig = useCallback((rig) => { rigRef.current = rig; setRigReady(!!rig); }, []);
  const onStatus = useCallback(({ role, ready, error }) => {
    if (!ready && error) say(`${role}: ${error}`, "warn");
  }, [say]);

  // Playing it is running a one-entry composition on the body in the room.
  function preview(ref, forEntry) {
    if (!ref) { say("give it a name first", "warn"); return; }
    const rig = rigRef.current;
    if (!rig) { say("no body in the room yet", "warn"); return; }
    runRef.current?.cancel();
    const role = forEntry?.role || entry.role || "a";
    runRef.current = runScript(
      { cast: Object.keys(cast).map(id => ({ id })), entries: [{ id: "preview", kind, role, ref }] },
      { drives: Object.keys(cast), performer: (r) => rig.performer(r),
        say: null, stopAll: () => rig.stopAll() },
      { onEvent: (e) => {
          if (e.type === "refused" || e.type === "warning" || e.type === "error") say(e.text, "warn");
        } },
    );
  }

  // Leaving with a draft in hand is the one way to lose this work, so it asks
  // — and offers to save rather than only to confirm the loss.
  function leave() {
    if (!dirty) return navigate("/lab/studio/interaction");
    const keep = window.confirm(
      "This animation has unsaved changes.\n\nOK to save it before leaving, or Cancel to discard it.");
    if (!keep) { setDirty(false); return navigate("/lab/studio/interaction"); }
    // Save runs inside the editor, which owns the draft; ask it, then leave
    // once it reports the work is no longer unsaved.
    leavingRef.current = true;
    saveRef.current?.();
  }

  const body = cast[entry.role];

  // "New Pose" until it has a name, then "Pose: Cross the arms". The editor
  // reports the name back through onStepChange, so this follows a Save.
  const KIND_LABEL = { pose: "Pose", action: "Action", reaction: "Reaction" };
  const openName = getAction(slug)?.name;
  const flavour = kind === "action" && (getAction(slug)?.needsProp ?? needsProp) ? "Room " : "";
  const title = openName ? `${flavour}${KIND_LABEL[kind]}: ${openName}`
                         : `New ${flavour || ""}${KIND_LABEL[kind]}`;

  return (
    <div style={{ minHeight: "100vh", background: PAPER, fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ maxWidth: 1500, margin: "0 auto", padding: "22px 26px 40px" }}>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            {/* The heading carries the kind. It was a dropdown in a card on the
                right called "What this is", which asked a question the page had
                already been told the answer to on the way in. */}
            <h1 style={{ fontFamily: "'Fraunces',Georgia,serif", fontSize: 24, margin: 0, color: "#2f2c28" }}>
              Animation editor <span style={{ color: "#a8a5a0" }}>—</span> {title}
            </h1>
            <p style={{ fontSize: 12.5, color: "#8b8781", margin: "5px 0 0" }}>
              {KIND_NOTE[kind]} Move a bone, and the body in the room is already standing in what you are making.
            </p>
          </div>
          <a onClick={leave}
             style={{ fontSize: 12, color: "#b05c08", cursor: "pointer" }}>← Interaction studio</a>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: log.length ? "minmax(0,1fr) 260px" : "minmax(0,1fr)", gap: 14, alignItems: "start" }}>

          {/* ── the room ─────────────────────────────────────────────────── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ ...cardStyle, padding: 0, overflow: "hidden", height: 520, position: "relative" }}>
              {/* Still: the body being authored must not move on its own. */}
              <InteractionStudioScene cast={cast} onRig={onRig} onStatus={onStatus} still />
              <div style={{ position: "absolute", right: 12, top: 12, display: "flex", gap: 8, zIndex: 4 }}>
                <select value={toAdd} style={{ ...btn(), width: 150 }}
                        onChange={e => setToAdd(e.target.value)}>
                  <option value="">— character —</option>
                  {castList.map(x => (
                    <option key={x.id} value={x.id} disabled={!!x.unavailable}>
                      {x.name}{x.kind === "you" ? " (you)" : ""}{x.unavailable ? ` — ${x.unavailable}` : ""}
                    </option>
                  ))}
                </select>
                <button style={btn(toAdd ? "primary" : "plain")} disabled={!toAdd}
                        onClick={() => {
                          const who = castList.find(x => x.id === toAdd);
                          if (!who) return;
                          // One body at a time here: this authors what ONE body
                          // does. A reaction is posed on the body it happens to,
                          // not on the pair — that is what makes it portable.
                          setCast({ a: who });
                          setToAdd("");
                          say(`${who.name} is in the room`);
                        }}>+ Add</button>
                {/* Furniture, so a room action can be authored against the thing
                    it happens at rather than against thin air. Rehearsal only —
                    the composition binds the real prop. */}
                {needsProp && (
                  <select value="" style={{ ...btn(), width: 118 }}
                          title="Put a piece of furniture in the room to author against"
                          onChange={e => {
                            if (!e.target.value) return;
                            rigRef.current?.addProp?.(e.target.value);
                            say(`placing a ${e.target.value} — click the floor, R turns it, Esc cancels`);
                          }}>
                    <option value="">+ Add prop</option>
                    {Object.entries(PROP_TYPES).map(([k, v]) => (
                      <option key={k} value={k}>{v.label}</option>
                    ))}
                  </select>
                )}
                {body && (
                  <button style={btn()} title="Take them out of the room"
                          onClick={() => { setCast({}); say(`${body.name} left the room`); }}>
                    × {body.name}
                  </button>
                )}
              </div>
            </div>

            {rigReady && (
              <InteractionActionEditor
                key={`anim-${kind}-${entry.id}`}
                rig={rigRef.current}
                stepIndex={0}
                step={entry}
                needsProp={needsProp}
                onStepChange={patch => {
                  setEntry(e => ({ ...e, ...patch }));
                  if (patch.action !== undefined) setSlug(patch.action);
                }}
                onSay={say}
                onPlay={preview}
                onDirty={(d) => {
                  setDirty(d);
                  // Saved on the way out: the guard asked to save, the editor
                  // says the draft is clean, so the trip continues.
                  if (!d && leavingRef.current) {
                    leavingRef.current = false;
                    navigate("/lab/studio/interaction");
                  }
                }}
                onSaveRef={saveRef}
              />
            )}
          </div>

          {/* The right column held "What this is" (a kind selector for a kind
              already chosen on the way in) and "In the library" (a list the
              studio's own library already shows, one click away). Both were
              answering questions nobody standing here is asking. What remains
              is the room and the bones. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {log.length > 0 && (
              <div style={cardStyle}>
                <p style={labelStyle}>Notes</p>
                {log.map((l, i) => (
                  <p key={i} style={{ margin: "0 0 3px", fontSize: 11.5, lineHeight: 1.5,
                                      color: l.tone === "warn" ? "#d85a30" : "#8b8781" }}>{l.text}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
