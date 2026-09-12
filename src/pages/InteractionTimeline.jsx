// ── the timeline ─────────────────────────────────────────────────────────────
//
// The steps ARE the sequence, so this is just the sequence drawn against time
// instead of stacked in a list. Two tracks, sharing one axis: what they DO on
// top, what you WATCH IT FROM underneath.
//
// The camera track is where it earns its place. Framing is inherited — a step
// with no camera of its own keeps the last one — and in a vertical list that
// inheritance is invisible: you read four steps and cannot see which shot is in
// force on any of them. Drawn as a bar that starts where the shot is set and
// runs until the next one, it is the only thing on screen that is obvious.
//
// Every width here is an ESTIMATE and the strip says so. A walk resolves when
// the feet arrive, not when arithmetic says it should; a body routing around
// furniture takes longer than this predicts. It is right about ORDER and
// roughly right about proportion, and nothing should be measured off it.

import { useEffect, useMemo, useRef, useState } from "react";
import { estimateTimeline, describeCamera, normalizeEntries, normalizeCameras,
         stepAt, describeEntry, ENTRY_KINDS } from "../lib/interactionScript.js";
import { getAction, listActions } from "../lib/bodyActions.js";
import { PROP_TYPES } from "./InteractionStudioScene.jsx";

// The same resolution order the rig uses — id, then slot, then type — so the
// strip measures the walk the runner will actually take. Two different answers
// to "which table" would put the block in the wrong place.
function findProp(list, ref) {
  const key = String(ref || "").toLowerCase();
  if (!key) return null;
  const all = list || [];
  return all.find(o => String(o.id).toLowerCase() === key)
      || all.find(o => String(o.slot || "").toLowerCase() === key)
      || all.find(o => String(o.type || "").toLowerCase() === key)
      || null;
}

const COLOR = {
  approach:      "#5b8fb9",
  walk_to:       "#5b8fb9",
  walk_to_prop:  "#5b8fb9",
  sit_on:        "#5f9e63",
  stand_up:      "#5f9e63",
  turn_to:     "#7aa6c2",
  say:         "#c9973a",
  interaction: "#b45309",
  reaction:    "#8a5cb8",
  clip:        "#4f9d8a",
  space:       "#5f9e63",
  wait:        "#9c968d",
};

export default function InteractionTimeline({ steps, cameras, selected, selectedCam, onSelect, onSelectCam,
                                              liveStep, marks, running, onPlay, onAddStep, onAddCamera,
                                              onMoveCamera, onScrub, onRemoveStep, onRemoveCamera,
                                              propList, cast = ["a", "b"],
                                              roster = null, onAddTo }) {
  const trackRef = useRef(null);
  const [head, setHead] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Which cut is being dragged by its leading edge. A cut has no length of its
  // own — it runs until the next one — so "resizing" one is really moving the
  // BOUNDARY, which is the start of the cut on the right of it.
  const [camDrag, setCamDrag] = useState(-1);
  const { blocks, total, norm } = useMemo(() => {
    const n = normalizeEntries(steps || [], { cast }).entries;
    const tl = estimateTimeline({ steps: n }, {
      marks,
      actionDuration: (slug) => getAction(slug)?.duration ?? 1,
      contactAt: (slug) => getAction(slug)?.contactAt ?? 0,
      propAt: (ref) => {
        const pr = findProp(propList, ref);
        if (!pr) return null;
        // Carry the seat's facing through, so the estimate walks to the same
        // side of the chair the rig will.
        const t = PROP_TYPES[pr.type];
        return { ...pr, seatFacing: t?.seatFacing ?? 0 };
      },
    });
    return { blocks: tl.blocks, total: Math.max(tl.total, 0.001), norm: n };
  }, [steps, marks, propList]);

  // Camera segments: from the step that sets a shot until the next one that
  // does. This is inheritance made visible.
  const shots = useMemo(() => {
    const cams = normalizeCameras(cameras, norm);
    const out = [];
    cams.forEach((c, i) => {
      const start = (blocks.find(b => b.id === c.entry)?.start ?? 0) + (c.offset || 0);
      const nxt = cams[i + 1];
      const end = nxt ? (blocks[nxt.step]?.start ?? total) + (nxt.offset || 0) : total;
      out.push({ index: i, start, end: Math.max(end, start + 0.05), camera: c });
    });
    // A script whose first shot is set halfway through is watched from the
    // orbit camera until then; say so rather than drawing nothing.
    if (out.length && out[0].start > 0.001) {
      out.unshift({ index: -1, start: 0, end: out[0].start, camera: null });
    }
    return out;
  }, [norm, blocks, total, cameras]);

  // Delete removes whatever is selected. The × on a block is the discoverable
  // way; this is the fast one. Guarded against firing while you are typing a
  // line of dialogue, which is exactly where a stray Backspace would hurt.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const t = e.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (selectedCam >= 0) { e.preventDefault(); onRemoveCamera?.(selectedCam); return; }
      if (selected >= 0) { e.preventDefault(); onRemoveStep?.(selected); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, selectedCam, onRemoveStep, onRemoveCamera]);

  // While a run plays, the head moves on a REAL clock and finishes at the end.
  //
  // It used to snap to the start of whatever step was live, which meant it came
  // to rest at the beginning of the last step and sat there — the run was over
  // and the head said it was three-quarters done. Snapping was the more honest
  // choice about POSITION (the widths are estimates) but it was a plain lie
  // about being FINISHED, which is the thing you actually look at.
  //
  // So: elapsed seconds, which is true, drawn against estimated widths, which
  // are not. The head may reach the end slightly before or after the blocks
  // suggest — that gap IS the estimate error, made visible rather than hidden.
  useEffect(() => {
    if (!running) return undefined;
    const t0 = performance.now();
    let raf = 0;
    const tick = () => {
      setHead(Math.min(total, (performance.now() - t0) / 1000));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Rest at the end, not wherever the clock happened to stop.
      setHead(total);
    };
  }, [running]);   // eslint-disable-line react-hooks/exhaustive-deps

  // NEVER return null for an empty script. The add buttons live on these
  // tracks, so hiding the timeline when there are no steps hid the only way to
  // make one — the strip vanished the moment a script was emptied and the page
  // offered nothing at all.
  const empty = blocks.length === 0;

  const pct = (v) => `${Math.max(0, Math.min(100, (v / total) * 100))}%`;
  // Clamped where it is DRAWN, not only where it is set. The play clock closes
  // over `total` at the moment the run starts, and that number can still change
  // underneath it — a saved action registering gives a step its real duration —
  // which is how the readout came to say "4.64s of ~4.6s".
  const headAt = Math.max(0, Math.min(head, total));

  // ── a track per character ────────────────────────────────────────────────
  //
  // A composition is who does what when, so the person is the axis. Everything
  // used to share one "action" track with lanes packed by overlap, which was
  // fine while there were two roles and nearly every entry belonged to the
  // first — and unreadable the moment three people were in the room, because
  // nothing about a bar said whose body it moved.
  //
  // An entry sits on the track of the body it MOVES. A slap is the striker's;
  // the person struck gets a tick at the contact instant on their own track,
  // so the blow is visible on both sides without pretending one entry is two.
  const who = roster && roster.length ? roster : cast.map(id => ({ id, name: id }));

  // Overlap still decides lanes, but only against the same character's own
  // entries: two things that genuinely run at once on one body must not draw
  // over each other, and a reaction no longer has to dodge an unrelated walk.
  const rows = who.map((slot) => {
    const ends = [];
    const items = [];
    blocks.forEach((b, i) => {
      if (norm[i].role !== slot.id) return;
      const start = b.start, end = b.start + Math.max(b.duration, 0.08);
      let l = 0;
      while (ends[l] !== undefined && ends[l] > start + 1e-6) l++;
      ends[l] = end;
      items.push({ index: i, lane: l });
    });
    const laneCount = items.length ? Math.max(1, ...items.map(x => x.lane + 1)) : 1;
    return { slot, items, laneCount, height: 6 + laneCount * 21 };
  });

  // Where a contact lands on the body it happens TO.
  const contactMarks = who.map(slot => blocks
    .map((b, i) => ({ b, e: norm[i] }))
    .filter(({ e }) => e.params?.target === slot.id && getAction(e.ref)?.aim)
    .map(({ b, e }) => b.start + (getAction(e.ref)?.contactAt ?? 0)));

  const ACTION_H = rows.reduce((h, r) => h + r.height + 2, 0);

  // Ticks every whole second, with halves when there is room. A ruler that
  // labelled every tick on a four-second script would be noise.
  const ticks = [];
  const stepSec = total > 12 ? 5 : total > 6 ? 2 : 1;
  if (!empty) for (let t = 0; t <= total + 1e-6; t += stepSec) ticks.push(t);

  const timeFromEvent = (e) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(total, ((e.clientX - r.left) / r.width) * total));
  };
  // A time on the strip, expressed the way a cut is stored: the step that is
  // live then, plus how far into it. Never an absolute second — the widths here
  // are estimates and an absolute time drifts as soon as a walk gets longer.
  const anchorFor = (t) => {
    let step = 0, start = 0;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i].start <= t + 1e-6) { step = i; start = blocks[i].start; }
    }
    return { step, offset: Math.max(0, +(t - start).toFixed(3)) };
  };

  const scrubTo = (e) => {
    const t = timeFromEvent(e);
    setHead(t);
    // The view follows the head continuously, not only when the head crosses
    // into a different step: a cut can sit partway through one, so scrubbing
    // inside a single step still has to change what you are looking at.
    onScrub?.(t);
    // Dragging the head selects whatever is live at that instant, which is what
    // stands the bodies there and applies the framing — the scrub IS the
    // selection, rather than a second way of moving through the script.
    const hit = stepAt({ blocks }, t);
    if (hit) {
      const i = blocks.indexOf(blocks.find(b => b.id === hit.id && b.start === hit.start));
      if (i >= 0 && i !== selected) onSelect?.(i);
    }
  };

  const label = { fontSize: 10, color: "#8b8781", textTransform: "uppercase", letterSpacing: ".06em" };
  const trackStyle = {
    position: "relative", borderRadius: 5,
    background: "#efece7", border: "1px solid #e2ddd5", overflow: "hidden",
  };
  const plus = {
    width: 24, height: 22, borderRadius: 4, cursor: "pointer",
    border: "1px solid #ddd8d0", background: "#fff", fontSize: 13, lineHeight: "18px",
  };

  return (
    <div style={{ border: "1px solid #e6e1d9", borderRadius: 8, padding: 10, background: "#faf8f5" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <button onClick={() => onPlay?.()} title={running ? "Stop" : "Play the script"}
                style={{ fontSize: 13, lineHeight: "20px", width: 30, height: 26, borderRadius: 5,
                         cursor: "pointer", border: "1px solid #b45309",
                         background: running ? "#fff" : "#b45309", color: running ? "#b45309" : "#fff" }}>
          {running ? "\u25a0" : "\u25b6"}
        </button>
        <strong style={{ fontSize: 12.5 }}>Timeline</strong>
        <span style={{ fontSize: 10.5, color: "#a8a5a0" }}>
          {empty
            ? "Empty — add a step with the + at the end of the action track."
            : `${headAt.toFixed(2)}s of ~${total.toFixed(1)}s · estimated: a walk ends when the feet arrive, not when this says`}
        </span>
      </div>

      <div style={{ display: "flex", gap: 6 }}>
        {/* labels */}
        <div style={{ width: 88, flex: "0 0 88px", paddingTop: 18 }}>
          {rows.map((r, ri) => (
            <div key={r.slot.id}
                 style={{ ...label, height: r.height, lineHeight: `${r.height}px`, marginTop: ri ? 2 : 0,
                          display: "flex", alignItems: "center", gap: 5, overflow: "hidden" }}>
              <span style={{ width: 7, height: 7, borderRadius: 7, flex: "0 0 auto",
                             background: r.slot.color || "#9c968d" }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.slot.name}
              </span>
            </div>
          ))}
          <div style={{ ...label, height: 30, lineHeight: "30px", marginTop: 4 }}>camera</div>
        </div>

        {/* the tracks, and the head that runs through both of them */}
        <div ref={trackRef} style={{ flex: 1, position: "relative", userSelect: "none" }}
             onMouseDown={(e) => { setDragging(true); scrubTo(e); }}
             onMouseMove={(e) => {
               if (camDrag >= 0) { onMoveCamera?.(camDrag, anchorFor(timeFromEvent(e))); return; }
               if (dragging) scrubTo(e);
             }}
             onMouseUp={() => { setDragging(false); setCamDrag(-1); }}
             onMouseLeave={() => { setDragging(false); setCamDrag(-1); }}>

          {/* ruler */}
          <div style={{ position: "relative", height: 16, borderBottom: "1px solid #e2ddd5", cursor: "pointer" }}>
            {ticks.map((t, i) => (
              <div key={i} style={{ position: "absolute", left: pct(t), top: 0, height: "100%",
                                    borderLeft: "1px solid #d8d2c9" }}>
                <span style={{ fontSize: 9, color: "#a8a5a0", marginLeft: 3 }}>{t.toFixed(0)}s</span>
              </div>
            ))}
          </div>

          {rows.map((r, ri) => (
            <div key={r.slot.id} style={{ ...trackStyle, height: r.height, marginTop: ri ? 2 : 2 }}>
              {/* A contact landing on this body, from someone else's action. */}
              {contactMarks[ri].map((t, k) => (
                <div key={"m" + k} title="a contact lands here"
                     style={{ position: "absolute", left: pct(t), top: 0, bottom: 0, width: 2,
                              marginLeft: -1, background: "rgba(216,90,48,.55)" }} />
              ))}
              {r.items.map(({ index: i, lane }) => {
                const bl = blocks[i];
                const st = norm[i];
                const sel = selected === i;
                return (
                  <div key={st.id || i}
                       onMouseDown={(e) => { e.stopPropagation(); onSelect?.(i); }}
                       title={describeEntry(st)}
                       style={{
                         position: "absolute", left: pct(bl.start),
                         width: `max(16px, ${pct(bl.duration)})`,
                         top: 3 + lane * 21, height: 19,
                         background: COLOR[st.kind] || "#9c968d",
                         opacity: sel ? 1 : liveStep === i ? 0.95 : 0.78,
                         border: sel ? "2px solid #2f2c28" : "1px solid rgba(0,0,0,.15)",
                         borderRadius: 4, cursor: "pointer", overflow: "hidden",
                         color: "#fff", fontSize: 10, lineHeight: "19px",
                         padding: "0 5px", whiteSpace: "nowrap", textOverflow: "ellipsis",
                       }}>
                    {i + 1}. {getAction(st.ref)?.name || st.ref}
                    {sel && (
                      <span onMouseDown={(e) => { e.stopPropagation(); onRemoveStep?.(i); }}
                            title="Remove this step (or press Delete)"
                            style={{ position: "absolute", right: 2, top: 0, padding: "0 4px",
                                     cursor: "pointer", fontSize: 12, lineHeight: "19px",
                                     color: "rgba(255,255,255,.85)" }}>×</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Cuts run edge to edge — each lasts until the next one — so there is
              no empty track to click. Cutting therefore has to work ON a bar,
              and it does: DOUBLE-CLICK anywhere on this row cuts at that point,
              while a single click still selects. Taller, too: 22px was a hard
              thing to hit with a double-click. */}
          <div style={{ ...trackStyle, height: 30, marginTop: 4, cursor: "copy" }}
               title="Double-click to cut here"
               onDoubleClick={(e) => {
                 e.stopPropagation();
                 if (empty) return;
                 onAddCamera?.(anchorFor(timeFromEvent(e)));
               }}
               onMouseDown={(e) => {
                 e.stopPropagation();
                 if (empty) return;
                 // A single click on bare track still cuts, for the case where
                 // there IS a gap (before the first cut).
                 if (e.target === e.currentTarget) onAddCamera?.(anchorFor(timeFromEvent(e)));
               }}>
            {shots.map((sh, i) => (
              <div key={i}
                   onMouseDown={(e) => { e.stopPropagation(); if (sh.index >= 0) onSelectCam?.(sh.index); }}
                   title={sh.camera ? describeCamera(sh.camera) : "free orbit — no shot set yet"}
                   style={{
                     position: "absolute", left: pct(sh.start), width: `max(16px, ${pct(sh.end - sh.start)})`,
                     top: 4, height: 22, borderRadius: 3,
                     background: sh.camera ? "#3f4a56" : "repeating-linear-gradient(45deg,#ddd8d0,#ddd8d0 4px,#efece7 4px,#efece7 8px)",
                     color: "#fff", fontSize: 10, lineHeight: "22px", padding: "0 8px",
                     whiteSpace: "nowrap", overflow: "hidden",
                     border: selectedCam === sh.index ? "2px solid #2f2c28" : "1px solid rgba(0,0,0,.15)",
                     cursor: sh.index >= 0 ? "pointer" : "default",
                   }}>
                {sh.camera ? describeCamera(sh.camera) : ""}
                {selectedCam === sh.index && sh.index >= 0 && (
                  <span onMouseDown={(e) => { e.stopPropagation(); onRemoveCamera?.(sh.index); }}
                        title="Remove this cut (or press Delete)"
                        style={{ position: "absolute", right: 2, top: 0, padding: "0 4px",
                                 cursor: "pointer", fontSize: 12, lineHeight: "22px",
                                 color: "rgba(255,255,255,.85)" }}>×</span>
                )}
                {sh.index >= 0 && (
                  <span onMouseDown={(e) => { e.stopPropagation(); setCamDrag(sh.index); }}
                        title="Drag to move this cut"
                        style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6,
                                 cursor: "col-resize", background: "rgba(255,255,255,.35)" }} />
                )}
              </div>
            ))}
          </div>

          {/* the head. One line through every track, because the whole point is
              that these two rows share a clock. */}
          <div style={{ position: "absolute", left: pct(headAt), top: 0, bottom: 0,
                        width: 1, background: "#b45309", pointerEvents: "none" }}>
            <div style={{ position: "absolute", left: -6, top: 0, width: 0, height: 0,
                          borderLeft: "6px solid transparent", borderRight: "6px solid transparent",
                          borderTop: "8px solid #b45309" }} />
          </div>
        </div>

        {/* One + per character. Which body performs an entry was a field you
            set afterwards on a row that always arrived saying "a"; now it is
            decided by WHERE you add it, which is the question the timeline was
            already asking. */}
        <div style={{ width: 30, flex: "0 0 30px", paddingTop: 18 }}>
          {rows.map((r, ri) => (
            <div key={r.slot.id}
                 style={{ height: r.height, marginTop: 2, display: "flex", alignItems: "center" }}>
              <AddMenu who={r.slot}
                       onPick={(ref) => (onAddTo ? onAddTo(ref, r.slot.id) : onAddStep?.(ref))} />
            </div>
          ))}
          <div style={{ height: 30, marginTop: 4, display: "flex", alignItems: "center" }}>
            {/* Cut at the head — the blade, for when you have scrubbed to the
                exact moment and would rather not hit it with a mouse. */}
                    <button onClick={() => onAddCamera?.(anchorFor(headAt))}
                    title="Cut at the playhead" style={plus}>{"\u2702"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// The action track's plus. A menu rather than a single button because there are
// eight verbs and picking one IS the decision — a "+" that added a default step
// would just make everybody delete it again.
function AddMenu({ onPick, who }) {
  return (
    <select value="" onChange={(e) => { if (e.target.value) onPick?.(e.target.value); }}
            title={who ? `Add something for ${who.name} to do` : "Add a step"}
            style={{ width: 30, height: 22, borderRadius: 4, border: "1px solid #ddd8d0",
                     background: "#fff", fontSize: 11, cursor: "pointer" }}>
      <option value="">+</option>
      {/* Grouped by kind, because that is what the library is. Picking one
          here is the same act as clicking it in the library panel — the entry
          arrives with that item's own declared parameters. */}
      {["action", "reaction", "pose"].map(kind => {
        const items = listActions(kind);
        if (!items.length) return null;
        return (
          <optgroup key={kind} label={ENTRY_KINDS[kind]?.label || kind}>
            {items.map(it => <option key={it.slug} value={it.slug}>{it.name}</option>)}
          </optgroup>
        );
      })}
    </select>
  );
}
