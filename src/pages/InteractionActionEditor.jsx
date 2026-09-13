// ── the body motion editor ───────────────────────────────────────────────────
//
// Bound to ONE step, editing ONE body's motion. A step of type `interaction` is
// the actor's half of a contact; a step of type `reaction` is the other body's
// answer to it. They are separate steps because the same slap can be met with a
// flinch, a laugh, or nothing at all — and because an action that only drives
// the actor is one an encounter can play, where the other role is a live player.
//
// ── the two decisions worth keeping ──────────────────────────────────────────
//
// EDITING IS CAPTURING. No capture button. Scrub to a moment, move a bone, and
// the keyframe is written at that moment. A capture button is a thing you
// forget to press — you pose for a minute, scrub away, and the work is gone.
//
// THE PREVIEW IS NOT A PREVIEW. The draft is registered into the same runtime
// registry the RUNNER reads, and Play dispatches a real step through the real
// runner. There is no second code path that can disagree with the first.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  RIGS, getAction, listActions, registerActions, normalizeAction, slugify,
} from "../lib/bodyActions.js";

// The bones worth offering, in the order a person thinks about them. The rig
// has 254 joints; a list that long is not a tool, it is a haystack.
const BONE_GROUPS = [
  { label: "right arm", bones: ["right_shoulder", "right_upper_arm", "right_forearm", "right_hand", "right_fingers"] },
  { label: "left arm",  bones: ["left_shoulder", "left_upper_arm", "left_forearm", "left_hand", "left_fingers"] },
  { label: "head",      bones: ["head", "neck_upper", "neck_lower"] },
  { label: "torso",     bones: ["chest", "upper_chest", "spine"] },
];

// What each axis MEANS depends on the bone. A head does not swing forward and
// an arm does not nod; making the author translate X/Y/Z in their head is
// making them make mistakes. These were MEASURED on Genesis 9.
const AXIS_SETS = {
  arm:   [{ i: 0, label: "swing", hint: "+ forward, − back" },
          { i: 1, label: "twist", hint: "along the limb" },
          { i: 2, label: "raise", hint: "− out to the side, + across the body" }],
  fingers: [{ i: 0, label: "grip",   hint: "curl all four fingers - drag either way, one closes" },
            { i: 1, label: "spread", hint: "fan the fingers apart" },
            { i: 2, label: "thumb",  hint: "curl the thumb in" }],
  head:  [{ i: 0, label: "nod",   hint: "+ down, − up" },
          { i: 1, label: "turn",  hint: "− away, + toward" },
          { i: 2, label: "tilt",  hint: "ear toward shoulder" }],
  torso: [{ i: 0, label: "lean",  hint: "+ forward, − back" },
          { i: 1, label: "twist", hint: "shoulders around the spine" },
          { i: 2, label: "bend",  hint: "sideways" }],
  hand:  [{ i: 0, label: "bend",  hint: "wrist up / down" },
          { i: 1, label: "turn",  hint: "palm up / down" },
          { i: 2, label: "splay", hint: "wrist side to side" }],
};
const axesFor = (bone) =>
  /fingers$/.test(bone) ? AXIS_SETS.fingers
  : /hand$/.test(bone) ? AXIS_SETS.hand
  : /head|neck/.test(bone) ? AXIS_SETS.head
  : /chest|spine/.test(bone) ? AXIS_SETS.torso
  : AXIS_SETS.arm;

const SCRATCH = "draft";
const draftSlug = (d) => d?.slug || slugify(d?.name) || SCRATCH;

const blank = (kind, needsProp = false) => ({
  slug: "", name: "", kind, duration: kind === "reaction" ? 0.8 : 1.0,
  ...(kind === "action" ? { contactAt: 0.45, contactDistance: 0.5 } : {}),
  // A room action happens AT something. `standAt` is how far in front of it the
  // body stops; the room works out where that is from the prop's footprint.
  ...(kind === "action" && needsProp ? { needsProp: true, standAt: 0.55 } : {}),
  tracks: [],
});

function valueAt(track, t) {
  const k = track?.keys;
  if (!k?.length) return [0, 0, 0];
  if (t <= k[0][0]) return k[0][1];
  if (t >= k[k.length - 1][0]) return k[k.length - 1][1];
  for (let i = 1; i < k.length; i++) {
    if (t <= k[i][0]) {
      const [t0, a] = k[i - 1], [t1, b] = k[i];
      const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      const e = u * u * (3 - 2 * u);
      return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e, a[2] + (b[2] - a[2]) * e];
    }
  }
  return k[k.length - 1][1];
}

export default function InteractionActionEditor({ rig, step, stepIndex, onStepChange, onPlay, onSay, onDirty, onSaveRef, needsProp = false }) {
  // The kind comes from the ENTRY now. It used to be derived from the step
  // type, which offered exactly two answers — and that is the whole reason a
  // held shape like crossed arms was filed as a "reaction": there was no way to
  // say "pose" anywhere in this editor.
  const kind = ["reaction", "pose"].includes(step?.kind) ? step.kind : "action";
  const role = step?.role || "a";

  const [saved, setSaved] = useState([]);
  const [draft, setDraft] = useState(() => blank(kind, needsProp));
  const [bone, setBone] = useState(kind === "reaction" ? "head" : "right_upper_arm");
  const [t, setT] = useState(0);
  const [busy, setBusy] = useState(false);
  // Clear-all arms on the first click and fires on the second (Magnus,
  // 2026-09-13). A confirm dialog would break the pose-tuning rhythm; a
  // silent one-click wipe would throw away a pose that took nine rounds to
  // find. Disarms by itself after 3s so it cannot lie in wait.
  const [armClear, setArmClear] = useState(false);
  useEffect(() => {
    if (!armClear) return;
    const id = setTimeout(() => setArmClear(false), 3000);
    return () => clearTimeout(id);
  }, [armClear]);

  const names = rig?.state?.() || {};
  const nameOf = (r) => names?.[r]?.name || r;
  const track = useMemo(() => (draft.tracks || []).find(x => x.bone === bone), [draft, bone]);
  const rot = useMemo(() => valueAt(track, t).map(n => Math.round(n)), [track, t]);

  useEffect(() => {
    let dead = false;
    fetch("/api/body-interactions", { credentials: "include" })
      .then(r => (r.ok ? r.json() : []))
      .then(list => { if (dead) return; setSaved(list); registerActions(list); })
      .catch(() => {});
    return () => { dead = true; };
  }, []);

  // Held in a ref, and publish depends on NOTHING. This callback is the
  // editor's spine: `open` depends on it, and an effect depends on `open`, so
  // anything that changes its identity re-runs that effect and reloads the
  // draft. Taking `onDirty` as a dependency did exactly that — the page passes
  // an inline arrow, a fresh function every render, so every slider move
  // published, re-rendered the page, changed the identity, and reset the draft
  // it had just written. The slider moved and sprang back.
  const dirtyRef = useRef(onDirty);
  dirtyRef.current = onDirty;

  const publish = useCallback((next, edited = false) => {
    setDraft(next);
    registerActions([{ ...next, slug: draftSlug(next) }]);
    // Dirty means EDITED, not "has tracks". Opening a saved animation to look
    // at it loads tracks and has changed nothing, and claiming otherwise would
    // make Back interrogate you about work you never did.
    if (edited) dirtyRef.current?.(true);
    return next;
  }, []);

  const open = useCallback((slug) => {
    const a = getAction(slug);
    setT(0);
    if (!a) return publish(blank(kind, needsProp));
    publish(structuredClone({ ...blank(kind, needsProp), ...a }));
  }, [kind, needsProp, publish]);

  // Follow the step: selecting a different one loads what THAT step names,
  // rather than leaving the last motion on screen looking as if it belonged to
  // the new selection.
  useEffect(() => { open(step?.action || ""); }, [step?.id, step?.action, open]);

  const hold = useCallback(() => {
    if (!rig) return;
    const slug = draftSlug(draft);
    registerActions([{ ...draft, slug }]);
    rig.poseAt(role, slug, t);
  }, [draft, t, rig, role]);
  useEffect(() => { hold(); }, [hold]);

  const release = () => rig?.poseAt(role, null, null);

  const setAxis = (axis, value) => {
    const next = structuredClone(draft);
    let tr = (next.tracks ||= []).find(x => x.bone === bone);
    if (!tr) { tr = { bone, keys: [] }; next.tracks.push(tr); }
    const cur = valueAt(tr, t).slice();
    cur[axis] = Number(value);
    const at = +t.toFixed(3);
    const i = tr.keys.findIndex(k => Math.abs(k[0] - at) < 0.005);
    if (i >= 0) tr.keys[i] = [at, cur];
    else { tr.keys.push([at, cur]); tr.keys.sort((p, q) => p[0] - q[0]); }
    // A track that does not start at rest pops on its first frame. Authoring
    // one is almost always an accident, so the rest key is added rather than
    // left to look wrong in playback.
    if (!tr.keys.some(k => k[0] === 0)) tr.keys.unshift([0, [0, 0, 0]]);
    publish(next, true);
  };

  // Every track, every bone — back to an unposed body, name and length kept.
  const clearAllKeys = () => {
    const next = structuredClone(draft);
    next.tracks = [];
    publish(next, true);
    setArmClear(false);
  };

  const removeKey = () => {
    const next = structuredClone(draft);
    const tr = (next.tracks || []).find(x => x.bone === bone);
    if (!tr) return;
    const at = +t.toFixed(3);
    tr.keys = tr.keys.filter(k => Math.abs(k[0] - at) >= 0.005);
    if (!tr.keys.length) next.tracks = next.tracks.filter(x => x.bone !== bone);
    publish(next, true);
  };

  const save = async () => {
    // Asked for HERE rather than typed into a box that sits there empty while
    // you work. Everything up to this point is a draft; naming it is the act
    // that makes it a library entry.
    let name = draft.name;
    if (!String(name || "").trim()) {
      name = window.prompt(`Name this ${kind}`, "");
      if (name === null) return;                 // cancelled — not a failure
      if (!String(name).trim()) return onSay?.("it needs a name", "warn");
      publish({ ...draft, name });
    }
    const payload = { ...draft, name, kind, slug: draft.slug || slugify(name) };
    const { errors } = normalizeAction(payload);
    if (errors.length) return onSay?.(errors.join("; "), "warn");
    setBusy(true);
    try {
      const r = await fetch("/api/body-interactions", {
        method: "POST", credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await r.json();
      if (!r.ok) return onSay?.(body.error || "save failed", "warn");
      const list = saved.filter(x => x.slug !== body.slug).concat(body);
      setSaved(list); registerActions(list);
      publish({ ...draft, slug: body.slug });
      // Point the step at what was just saved, or it keeps naming the slug it
      // had before the rename and plays the wrong motion.
      onStepChange?.({ action: body.slug });
      onSay?.(`saved “${body.name}”`);
      dirtyRef.current?.(false);
    } finally { setBusy(false); }
  };

  // The page owns Back and therefore owns "save before you go", but the draft
  // lives here. Handing the function over is the smallest way to let the guard
  // run the real Save rather than a second copy of it.
  useEffect(() => { if (onSaveRef) onSaveRef.current = save; });

  const lbl = { fontSize: 11, color: "#8b8781", textTransform: "uppercase", letterSpacing: ".06em" };
  const cell = { fontSize: 12, padding: "4px 6px", border: "1px solid #ddd8d0", borderRadius: 4, background: "#fff" };
  const btn = (k) => ({
    fontSize: 12, padding: "5px 10px", borderRadius: 5, cursor: "pointer",
    border: "1px solid " + (k === "primary" ? "#b45309" : "#ddd8d0"),
    background: k === "primary" ? "#b45309" : "#fff",
    color: k === "primary" ? "#fff" : "#3a3733",
  });

  return (
    <div style={{ border: "1px solid #e6e1d9", borderRadius: 8, padding: 12, background: "#faf8f5" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        {/* What this is and whose body it is posing are said by the PAGE, in
            its heading. Repeating them here as "Step 1 · action" was both
            redundant and, after the kind moved into the page, wrong. The name
            is asked for at Save, because a thing has no name until it is one. */}
        <span style={{ fontSize: 11.5, color: "#b05c08" }}>
          {draft.name ? `“${draft.name}”` : "unsaved"} · poses {nameOf(role)}
        </span>
        {/* A pose is a shape, not a span — the only time in it is how long the
            body takes to arrive, which nobody authors per pose. An action and a
            reaction are motions over time, and their length is the thing you
            tune against a contact. */}
        {kind !== "pose" && (
          <label style={lbl} title="How long the motion takes from start to rest.">length
            <input type="number" step="0.05" min="0.05" max="10"
                   style={{ ...cell, width: 62, marginLeft: 4 }}
                   value={draft.duration}
                   onChange={ev => publish({ ...draft, duration: Number(ev.target.value) }, true)} />
            <span style={{ marginLeft: 3, textTransform: "none" }}>s</span>
          </label>
        )}
        {kind === "action" && draft.needsProp && (
          <label style={lbl} title="How far in front of the furniture the body stops. The room works out where that is from the prop's footprint.">
            stand at
            <input type="number" step="0.05" min="0.2" max="3"
                   style={{ ...cell, width: 62, marginLeft: 4 }}
                   value={draft.standAt ?? 0.55}
                   onChange={ev => publish({ ...draft, standAt: Number(ev.target.value) }, true)} />
            <span style={{ marginLeft: 3, textTransform: "none" }}>m</span>
          </label>
        )}
        {kind === "action" && [
          { key: "contactAt", label: "contact at", unit: "s",
            hint: "When in this motion the blow lands. A reaction is timed against this instant, not against the step list." },
          { key: "contactDistance", label: "contact from", unit: "m",
            hint: "The separation this motion was authored at. There is no collision test — the distance is part of the action." },
        ].map(f => (
          <label key={f.key} style={lbl} title={f.hint}>{f.label}
            <input type="number" step="0.05" style={{ ...cell, width: 62, marginLeft: 4 }}
                   value={draft[f.key] ?? 0}
                   onChange={e => publish({ ...draft, [f.key]: Number(e.target.value) }, true)} />
            <span style={{ marginLeft: 3, textTransform: "none" }}>{f.unit}</span>
          </label>
        ))}
        <span style={{ flex: 1 }} />
        <button style={btn()} onClick={() => { const slug = draftSlug(draft); registerActions([{ ...draft, slug }]); release(); onPlay?.(slug, step); }}>▶ Play it</button>
        <button style={btn("primary")} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        <button style={btn()} onClick={release}>Release</button>
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ ...lbl, marginBottom: 3 }}>
          t = {t.toFixed(2)}s of {(draft.duration || 1).toFixed(2)}s
          {kind === "action" && Math.abs(t - (draft.contactAt ?? -1)) < 0.02 ? "  ·  CONTACT" : ""}
        </div>
        <input type="range" min={0} max={draft.duration || 1} step={0.01}
               value={Math.min(t, draft.duration || 1)}
               onChange={e => setT(Number(e.target.value))} style={{ width: "100%" }} />
        {kind === "action" && (
          <div style={{ position: "relative", height: 10 }}>
            <div style={{ position: "absolute", left: `${((draft.contactAt || 0) / (draft.duration || 1)) * 100}%`,
                          transform: "translateX(-50%)", fontSize: 10, color: "#b05c08" }}>▲ contact</div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <select size={8} style={{ ...cell, width: 150 }} value={bone} onChange={e => setBone(e.target.value)}>
          {BONE_GROUPS.map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.bones.filter(b => RIGS.genesis9[b]).map(b => {
                const has = (draft.tracks || []).find(x => x.bone === b);
                return <option key={b} value={b}>{b.replace(/_/g, " ")}{has ? ` (${has.keys.length})` : ""}</option>;
              })}
            </optgroup>
          ))}
        </select>

        <div style={{ flex: 1, minWidth: 260 }}>
          {axesFor(bone).map(ax => (
            <div key={ax.i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ ...lbl, width: 44 }}>{ax.label}</span>
              <input type="range" min={-180} max={180} step={1} value={rot[ax.i]}
                     onChange={e => setAxis(ax.i, e.target.value)} style={{ flex: 1 }} />
              <span style={{ fontSize: 11, width: 34, textAlign: "right" }}>{rot[ax.i]}°</span>
              <span style={{ fontSize: 10, color: "#a09a91", width: 190 }}>{ax.hint}</span>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <button style={{ ...btn(), fontSize: 11, padding: "4px 8px" }} onClick={removeKey}>Delete key at t</button>
            <button style={{ ...btn(armClear ? "primary" : "plain"), fontSize: 11, padding: "4px 8px" }}
                    title="Remove every keyframe on every bone — the pose goes back to an unposed body. Click twice."
                    onClick={() => (armClear ? clearAllKeys() : setArmClear(true))}>
              {armClear ? "Clear all keys — sure?" : "Clear all keys"}
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#8b8781", marginTop: 6 }}>
            Moving a slider writes a keyframe at t. Keys on this bone:{" "}
            {(track?.keys || []).map(k => k[0].toFixed(2)).join(", ") || "none"}
          </div>
        </div>
      </div>
    </div>
  );
}
