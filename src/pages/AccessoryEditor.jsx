// AccessoryEditor.jsx
// The ONE wardrobe-editing surface — region/slot picker, per-garment and
// per-part fit (scale/offset/rotation), and tint. Extracted verbatim from
// CharacterWizard.jsx's Accessories step (was ~350 lines inline, only ever
// used once) so ActorModelPanel's Inspect › Wardrobe panel could reuse the
// identical editing UI instead of a second implementation.
//
// Magnus's call, explicit: "share dressing components with the character
// wizard, one place to change." This component owns NO state itself —
// every value and setter is a prop. CharacterWizard and ActorModelPanel
// each keep their own accessories/draft state; this is purely the shared
// UI plus the shared occlusion/override rules (Session 108's design), so
// the two callers can never drift on what "hidden under her jeans" means.
//
// Do not fork this file per-caller. If a caller needs different behavior,
// that's a new prop, not a copy.

// ---- schema (moved from CharacterWizard.jsx — that file now imports these
// rather than defining its own copy) --------------------------------------

// Real slot schema for the Accessories tab (Session 97) — the fuller
// hierarchy from the original design discussion, not just the simplified
// mockup (which only had Head/Neck/Torso/Legs/Hands/Feet). Options here
// are placeholders — no real DAZ assets exist for any of these slots
// yet, that's separate, later work. This pass is specifically about
// making the tree+modal picker real and interactive, matching the
// mockup's own proven interaction pattern.
export const ACCESSORY_SCHEMA = {
  Head: { Hairstyle: ["None", "Kin Hair", "Bob cut", "Ponytail", "Braided"], Headwear: ["None", "Sun hat", "Beanie", "Crown"] },
  Neck: { Necklace: ["None", "Pendant", "Choker", "Pearls"] },
  Torso: { Top: ["None", "T-shirt", "Blouse", "Jacket", "Sweater"] },
  Legs: { Bottom: ["None", "Jeans", "Skirt", "Shorts", "Trousers"] },
  Hands: { Gloves: ["None", "Leather gloves", "Fingerless gloves"], Ring: ["None", "Wedding ring", "Signet ring"] },
  Feet: { Footwear: ["None", "Heels", "Sneakers", "Boots", "Sandals"] },
  Back: { Back: ["None", "Backpack", "Cape"] },
  Underwear: { Top: ["None", "Basic Bra"], Bottom: ["None", "Basic Panties"] },
  "Full Outfit": { "Full Outfit": ["None", "Casual set", "Formal set", "Athletic set"] },
};

// Full Outfit is special — selecting one overrides Torso and Legs
// entirely (per the original design note), so those two regions need to
// visually reflect that rather than behave as independent slots.
export const OVERRIDDEN_BY_FULL_OUTFIT = ["Torso", "Legs"];

// Session 108 — layer occlusion, the game-developer rule: outerwear
// HIDES underwear rather than rendering shells stacked on shells
// (two garments' clearance plus mesh thickness inflated the
// silhouette visibly — "the z-layer makes her look big"). Keyed by
// slotKey: an outer slot with a real selection suppresses its inner
// slot from the viewer and from the dressed export. Hiding, NOT
// deselecting: the underwear choice and tint remain character data
// (wardrobe state matters to the simulator someday) — remove the
// jeans and the panties are still hers. Absolute per-slot rule for
// now; if a sheer top ever wants visible bra straps, this graduates
// to a per-garment catalog flag.
export const OCCLUDES = { "Legs.Bottom": "Underwear.Bottom", "Torso.Top": "Underwear.Top" };

// Maps a directory category (from GET /api/accessories, e.g. "head/hair")
// to the corresponding ACCESSORY_SCHEMA region/slot. Any category listed
// here is treated as fully dynamic — its real options come entirely from
// the backend scan of public/media/accessories/, replacing the static
// ACCESSORY_SCHEMA placeholder array for that slot. Categories not
// listed here keep using the old static placeholder options unchanged,
// so this can be extended one slot at a time as real assets land for
// each.
export const ACCESSORY_CATEGORY_TO_SLOT = {
  "head/hair": { region: "Head", slot: "Hairstyle" },
  "underwear/top": { region: "Underwear", slot: "Top" },
  "underwear/bottom": { region: "Underwear", slot: "Bottom" },
  // Session 108 — first real outerwear (Angie jeans). Maps to the
  // schema's existing Legs/Bottom slot, replacing its static
  // placeholder list; Legs camera preset already exists.
  "legs/pants": { region: "Legs", slot: "Bottom" },
  // Session 108 — footwear (Angie sneakers). Directory mirrors the
  // local asset taxonomy (Legs/Shoes); maps to the schema's Feet
  // region, Footwear slot. Feet camera preset already exists.
  "legs/shoes": { region: "Feet", slot: "Footwear" },
  // Session 108 — tops (Angie top). Torso region, Top slot.
  "torso/top": { region: "Torso", slot: "Top" },
};

export function defaultAccessories() {
  const result = {};
  for (const region of Object.keys(ACCESSORY_SCHEMA)) {
    result[region] = {};
    for (const slot of Object.keys(ACCESSORY_SCHEMA[region])) {
      result[region][slot] = "None";
    }
  }
  return result;
}

// Session 102 — game-equipment navigation (AC/WoW pattern): picking a
// region focuses MiniGlbViewer's camera on it via its focusRegion prop.
// Shared so ActorModelPanel's preview camera behaves the same way the
// wizard's does when browsing regions.
export const ACCESSORY_REGION_CAMERA = {
  Head: "head", Neck: "head", Torso: "torso", Underwear: "torso",
  Hands: "torso", Legs: "legs", Feet: "legs", Back: "fullBody", "Full Outfit": "fullBody",
};

// ---- URL helpers (moved from CharacterWizard.jsx) ------------------------

// draft_state / selectedAccessoryGlbUrls store the CANONICAL url without
// the ?v= cache-bust stamp; the current stamp is applied only when
// building the viewer's accessory list. Found live: a draft saved a
// stamped url, assets were re-uploaded (new mtime), the stale stamp made
// the selected garment look unselected, and re-picking it "as a change"
// wiped the restored fit adjustments.
export const stripV = (u) => (u ? u.split("?")[0] : u);

export function freshUrl(dynamicAccessoryOptions, canonical) {
  for (const list of Object.values(dynamicAccessoryOptions || {})) {
    const hit = list.find((item) => stripV(item.glbUrl) === canonical);
    if (hit) return hit.glbUrl;
  }
  return canonical;
}

// Fetches and groups /api/accessories into the same { "Region.Slot": [...] }
// shape both callers need. One copy of the grouping logic, not two.
export async function fetchAccessoryOptions() {
  const r = await fetch("/api/accessories");
  const data = await r.json();
  const grouped = {};
  for (const item of data.accessories || []) {
    const slotInfo = ACCESSORY_CATEGORY_TO_SLOT[item.category];
    if (!slotInfo) continue; // category not wired to a UI slot yet — ignore for now
    const key = `${slotInfo.region}.${slotInfo.slot}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  }
  return grouped;
}

// Builds the `accessories` array MiniGlbViewer expects, applying the SAME
// occlusion rule both callers rely on: while the editor is open on an
// inner slot, its covering outer garment steps aside so the pick isn't
// made blind; otherwise the outer hides the inner as normal. This was
// previously inline at CharacterWizard's <MiniGlbViewer> call site —
// moved here so ActorModelPanel's preview can't drift from the wizard's.
export function buildViewerAccessories({
  selectedAccessoryGlbUrls,
  accessoryScales,
  accessoryOffsets,
  accessoryRotations,
  accessoryParts,
  accessoryTints,
  activeSlot,
  dynamicAccessoryOptions,
}) {
  const activeKey = activeSlot ? `${activeSlot.region}.${activeSlot.slot}` : null;
  const editingOuters = new Set(
    Object.entries(OCCLUDES).filter(([, inner]) => inner === activeKey).map(([outer]) => outer)
  );
  const occluded = new Set(
    Object.entries(OCCLUDES)
      .filter(([outer]) => selectedAccessoryGlbUrls[outer] && !editingOuters.has(outer))
      .map(([, inner]) => inner)
  );
  return Object.entries(selectedAccessoryGlbUrls)
    .filter(([key, url]) => url && !occluded.has(key) && !editingOuters.has(key))
    .map(([key, url]) => ({
      url: freshUrl(dynamicAccessoryOptions, stripV(url)),
      scale: accessoryScales[key] || { x: 1, y: 1, z: 1 },
      offset: accessoryOffsets[key] || { x: 0, y: 0, z: 0 },
      rotation: accessoryRotations[key] || { x: 0, y: 0, z: 0 },
      parts: accessoryParts[key] || {},
      tint: accessoryTints[key],
    }));
}

// ---- style tokens used by the picker JSX below (moved from CharacterWizard's S) --
const S = {
  secLabel: { fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "#a8a5a0", marginBottom: 14, marginTop: 24, paddingBottom: 10, borderBottom: "1px solid rgba(0,0,0,0.06)" },
  sliderRow: { display: "flex", alignItems: "center", gap: 12, marginBottom: 12 },
  sliderLbl: { fontFamily: "'DM Sans',system-ui,sans-serif", fontSize: 12, color: "#6b6760", width: 120, flexShrink: 0 },
  sliderVal: { fontFamily: "'DM Mono',monospace,sans-serif", fontSize: 12, color: "#b05c08", width: 28, textAlign: "right", flexShrink: 0 },
};

// ---- the editor itself -----------------------------------------------------
// Every prop below is state or a setter the CALLER owns. This component
// reads and writes through the setters exactly as CharacterWizard's inline
// version did — no behavior change from the extraction, only location.
export default function AccessoryEditor({
  accessories, setAccessories,
  dynamicAccessoryOptions,
  selectedAccessoryGlbUrls, setSelectedAccessoryGlbUrls,
  accessoryScales, setAccessoryScales,
  accessoryOffsets, setAccessoryOffsets,
  accessoryRotations, setAccessoryRotations,
  accessoryParts, setAccessoryParts,
  accessoryTints, setAccessoryTints,
  accessoryPartNames,
  activeSlot, setActiveSlot,
  scaleDetailSlot, setScaleDetailSlot,
  activePart, setActivePart,
  activeAccessoryRegion, setActiveAccessoryRegion,
}) {
  // Session 102 — one true way to zero a slot's manual fit (scale,
  // offset, rotation, all per-part adjustments). Used both when a
  // garment is picked (fresh fit) and by the Reset fit button.
  const resetSlotFit = (slotKey) => {
    const drop = (setter) => setter((prev) => { const n = { ...prev }; delete n[slotKey]; return n; });
    drop(setAccessoryScales); drop(setAccessoryOffsets); drop(setAccessoryRotations); drop(setAccessoryParts); drop(setAccessoryTints);
    setActivePart(null);
  };

  return (
    <div>
{/* AUTOGEN-BOUNDARY: everything below to the closing tag is byte-identical
    to CharacterWizard.jsx lines 2532-2860 (Session 108), sliced directly
    from source rather than retyped, to guarantee zero behavior drift on
    extraction. */}
              {activeSlot ? (() => {
                const slotKey = `${activeSlot.region}.${activeSlot.slot}`;
                const dynamicList = dynamicAccessoryOptions[slotKey];
                const inDetailView = scaleDetailSlot === slotKey;
                const selectedLabel = accessories[activeSlot.region][activeSlot.slot];
                const selectedItem = dynamicList?.find(item => item.displayName === selectedLabel);
                const scale = accessoryScales[slotKey] || { x: 1, y: 1, z: 1 };
                const setScale = (updates) => setAccessoryScales(prev => ({ ...prev, [slotKey]: { ...(prev[slotKey] || { x: 1, y: 1, z: 1 }), ...updates } }));
                const setUniform = (v) => setAccessoryScales(prev => ({ ...prev, [slotKey]: { x: v, y: v, z: v } }));
                const offset = accessoryOffsets[slotKey] || { x: 0, y: 0, z: 0 };
                const setOffset = (updates) => setAccessoryOffsets(prev => ({ ...prev, [slotKey]: { ...(prev[slotKey] || { x: 0, y: 0, z: 0 }), ...updates } }));
                // Per-part editing. partNames comes from the viewer's
                // post-load report for this slot's GLB; the pills render
                // only when a garment actually has multiple parts.
                // Session 148 — "make sure the pills reload correctly":
                // two silent-failure classes closed. (1) The report is
                // keyed by the exact URL string the viewer loaded, which
                // carries a ?v= cache-bust — any drift between that and
                // the option's stored URL (v changed between sessions,
                // one side raw) made this lookup miss with NO error and
                // NO pills. Exact match first, then a pathname match,
                // loudly logged when the fallback engages. (2) An
                // activePart surviving from a previously opened garment
                // self-heals to Whole (documented React adjust-during-
                // render pattern; the condition is false on the
                // immediate re-render).
                const partNames = (() => {
                  const url = selectedItem?.glbUrl;
                  if (!url) return [];
                  if (accessoryPartNames[url]) return accessoryPartNames[url];
                  const strip = (u) => u.split("?")[0];
                  const hit = Object.keys(accessoryPartNames).find((k) => strip(k) === strip(url));
                  if (hit) {
                    console.warn(`[AccessoryEditor] part names for "${url}" found under a cache-bust key variant ("${hit}") — pills rendered via pathname match; the two URL sources disagree on ?v.`);
                    return accessoryPartNames[hit];
                  }
                  return [];
                })();
                if (activePart && partNames.length > 0 && !partNames.includes(activePart)) {
                  console.warn(`[AccessoryEditor] active part "${activePart}" does not exist on this garment (parts: ${partNames.join(", ")}) — stale selection from a previous garment; resetting to Whole.`);
                  setActivePart(null);
                }
                const slotParts = accessoryParts[slotKey] || {};
                const partAdj = activePart ? (slotParts[activePart] || { scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }) : null;
                const setPartAdj = (kind, updates) => setAccessoryParts(prev => {
                  const slot = prev[slotKey] || {};
                  const part = slot[activePart] || { scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
                  return { ...prev, [slotKey]: { ...slot, [activePart]: { ...part, [kind]: { ...part[kind], ...updates } } } };
                });
                const rotationVal = accessoryRotations[slotKey] || { x: 0, y: 0, z: 0 };
                const setRotation = (updates) => setAccessoryRotations(prev => ({ ...prev, [slotKey]: { ...(prev[slotKey] || { x: 0, y: 0, z: 0 }), ...updates } }));
                const togglePartVisible = (p) => setAccessoryParts(prev => {
                  const slot = prev[slotKey] || {};
                  const part = slot[p] || { scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
                  return { ...prev, [slotKey]: { ...slot, [p]: { ...part, visible: part.visible === false } } };
                });
                const setPartUniform = (v) => setAccessoryParts(prev => {
                  const slot = prev[slotKey] || {};
                  const part = slot[activePart] || { scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
                  return { ...prev, [slotKey]: { ...slot, [activePart]: { ...part, scale: { x: v, y: v, z: v } } } };
                });
                // The values the sliders below actually show/edit: the
                // whole garment when no part is selected, else that
                // part's own factors (which multiply/add on top).
                const shownScale = activePart ? partAdj.scale : scale;
                const shownOffset = activePart ? partAdj.offset : offset;
                const shownRotation = activePart ? (partAdj.rotation || { x: 0, y: 0, z: 0 }) : rotationVal;
                const editScale = (updates) => activePart ? setPartAdj("scale", updates) : setScale(updates);
                const editUniform = (v) => activePart ? setPartUniform(v) : setUniform(v);
                const editOffset = (updates) => activePart ? setPartAdj("offset", updates) : setOffset(updates);
                const editRotation = (updates) => activePart ? setPartAdj("rotation", updates) : setRotation(updates);
                // Session 107 — colour follows the same whole-garment /
                // per-part rule as the fit sliders. Per-part tint is a
                // flat value on the part object (not nested like
                // scale/offset), so it gets its own setter.
                const shownTint = activePart ? (slotParts[activePart]?.tint || accessoryTints[slotKey] || "#ffffff") : (accessoryTints[slotKey] || "#ffffff");
                const editTint = (hex) => {
                  if (activePart) {
                    setAccessoryParts(prev => {
                      const slot = prev[slotKey] || {};
                      const part = slot[activePart] || { scale: { x: 1, y: 1, z: 1 }, offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
                      return { ...prev, [slotKey]: { ...slot, [activePart]: { ...part, tint: hex } } };
                    });
                  } else {
                    setAccessoryTints(prev => ({ ...prev, [slotKey]: hex }));
                  }
                };

                return (
                <div>
                  <div
                    onClick={()=> { if (inDetailView) { setScaleDetailSlot(null); setActivePart(null); } else { setActiveSlot(null); } }}
                    style={{display:"flex",alignItems:"center",gap:8,marginBottom:18,cursor:"pointer"}}
                    onMouseEnter={e=>{e.currentTarget.style.opacity=0.65}}
                    onMouseLeave={e=>{e.currentTarget.style.opacity=1}}
                  >
                    <span style={{fontSize:13,color:"#a8a5a0"}}>←</span>
                    <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:11,letterSpacing:"0.1em",textTransform:"uppercase",color:"#1a1814",fontWeight:500}}>{inDetailView ? selectedLabel : activeSlot.slot}</span>
                  </div>

                  {inDetailView ? (
                    <div>
                      {selectedItem?.thumbnailUrl ? (
                        <img src={selectedItem.thumbnailUrl} alt={selectedLabel} style={{width:160,height:160,borderRadius:8,objectFit:"cover",display:"block",margin:"0 auto 20px"}} />
                      ) : (
                        <div style={{width:160,height:160,borderRadius:8,background:"rgba(0,0,0,0.06)",margin:"0 auto 20px"}} />
                      )}
                      <button onClick={()=>resetSlotFit(slotKey)}
                        title="Zero every manual adjustment for this garment — scale, position, rotation, and all per-part tweaks"
                        style={{display:"block", margin:"-8px auto 16px", padding:"6px 14px", fontFamily:"'DM Mono',monospace", fontSize:10,
                          letterSpacing:"0.08em", textTransform:"uppercase", border:"1px solid rgba(199,180,140,0.35)",
                          borderRadius:8, background:"transparent", color:"#6b6760", cursor:"pointer"}}>
                        ↺ Reset fit</button>
                      {/* Part selector — only for garments that load as
                          several primitives (parts reported back by the
                          viewer, keyed by material name). "Whole" edits
                          the garment-level transform; a part pill edits
                          that part's own adjustment, which multiplies
                          (scale) / adds (offset) on top of Whole. */}
                      {partNames.length > 1 && (
                        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
                          {[null, ...partNames].map((p) => {
                            const sel = activePart === p;
                            const touched = p && slotParts[p];
                            const hidden = p && slotParts[p]?.visible === false;
                            return (
                              <div key={p || "__whole"}
                                onClick={() => setActivePart(p)}
                                style={{display:"flex",alignItems:"center",gap:5,fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,letterSpacing:"0.04em",padding:"4px 9px",borderRadius:12,cursor:"pointer",border:sel?"1px solid #1a1814":"1px solid rgba(0,0,0,0.12)",background:sel?"rgba(26,24,20,0.06)":"none",color:"#1a1814",opacity:hidden?0.45:1}}
                              >
                                <span style={{textDecoration:hidden?"line-through":"none"}}>{p ? p.replace(/_/g, " ") : "Whole"}{touched ? " •" : ""}</span>
                                {p && (
                                  <span
                                    onClick={(e) => { e.stopPropagation(); togglePartVisible(p); }}
                                    title={hidden ? "Show part" : "Hide part"}
                                    style={{fontSize:11,lineHeight:1,cursor:"pointer",userSelect:"none"}}
                                  >{hidden ? "\u25cc" : "\u25c9"}</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Adjustments-panel row layout (label | slider |
                          amber value), matching the body sliders on the
                          Appearance step. Reset moved onto the value
                          itself: click the number to reset. */}
                      <div style={S.secLabel}>Scale</div>
                      {/* Session 107 — COLOUR. One picker, same
                          whole/part rule as the sliders: tints the
                          whole garment, or just the active part.
                          Multiplies against the white-authored
                          diffuse, so white = as-authored. */}
                      <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
                        <span style={S.sliderLbl}>Colour{activePart ? ` (${activePart.replace(/_/g," ")})` : ""}</span>
                        <input type="color" value={shownTint} onChange={e=>editTint(e.target.value)} style={{width:44,height:28,padding:0,border:"1px solid rgba(0,0,0,0.15)",borderRadius:6,cursor:"pointer",background:"none"}} />
                        <span style={{fontFamily:"'DM Mono',monospace,sans-serif",fontSize:11,color:"#6b6760"}}>{shownTint}</span>
                        {shownTint.toLowerCase() !== "#ffffff" && (
                          <span onClick={()=>editTint("#ffffff")} style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,color:"#b05c08",cursor:"pointer",textDecoration:"underline"}}>white</span>
                        )}
                      </div>
                      {[
                        { label: "Uniform Scale", axis: null },
                        { label: "X", axis: "x" },
                        { label: "Y", axis: "y" },
                        { label: "Z", axis: "z" },
                      ].map(({ label, axis }) => {
                        // Session 103 — Uniform shows the COMMON value only when the
                        // scale actually is uniform; otherwise it parks at 1.00.
                        // (It used to display scale.x, so dragging X dragged the
                        // Uniform thumb along — a writer masquerading as a reader.)
                        const value = axis ? shownScale[axis] : ((shownScale.x === shownScale.y && shownScale.y === shownScale.z) ? shownScale.x : 1);
                        return (
                          <div key={label} style={S.sliderRow}>
                            <span style={S.sliderLbl}>{label}</span>
                            <input
                              type="range" min={0.1} max={3} step={0.01} value={value}
                              onChange={e => axis ? editScale({ [axis]: parseFloat(e.target.value) }) : editUniform(parseFloat(e.target.value))}
                              style={{flex:1,accentColor:"#b05c08",height:4,cursor:"pointer"}}
                            />
                            <span
                              onClick={() => axis ? editScale({ [axis]: 1 }) : editUniform(1)}
                              title="Click to reset"
                              style={{...S.sliderVal,width:52,cursor:"pointer"}}
                            >{value.toFixed(2)}x</span>
                          </div>
                        );
                      })}
                      {/* Position offset — placement, not size. Values
                          shown in cm; stored in meters. Click the value
                          to reset. */}
                      <div style={S.secLabel}>Position Offset</div>
                      {[
                        { label: "Offset X (side)", axis: "x" },
                        { label: "Offset Y (up/down)", axis: "y" },
                        { label: "Offset Z (front/back)", axis: "z" },
                      ].map(({ label, axis }) => {
                        const value = shownOffset[axis];
                        return (
                          <div key={label} style={S.sliderRow}>
                            <span style={S.sliderLbl}>{label}</span>
                            <input
                              type="range" min={-0.25} max={0.25} step={0.001} value={value}
                              onChange={e => editOffset({ [axis]: parseFloat(e.target.value) })}
                              style={{flex:1,accentColor:"#b05c08",height:4,cursor:"pointer"}}
                            />
                            <span
                              onClick={() => editOffset({ [axis]: 0 })}
                              title="Click to reset"
                              style={{...S.sliderVal,width:52,cursor:"pointer"}}
                            >{(value * 100).toFixed(1)}cm</span>
                          </div>
                        );
                      })}
                      {/* Rotation — degrees, XYZ Euler, around each
                          part's own center (after scale, before
                          offset). Click the value to reset. */}
                      <div style={S.secLabel}>Rotation</div>
                      {[
                        { label: "Rotate X (pitch)", axis: "x" },
                        { label: "Rotate Y (yaw)", axis: "y" },
                        { label: "Rotate Z (roll)", axis: "z" },
                      ].map(({ label, axis }) => {
                        const value = shownRotation[axis];
                        return (
                          <div key={label} style={S.sliderRow}>
                            <span style={S.sliderLbl}>{label}</span>
                            <input
                              type="range" min={-45} max={45} step={1} value={value}
                              onChange={e => editRotation({ [axis]: parseFloat(e.target.value) })}
                              style={{flex:1,accentColor:"#b05c08",height:4,cursor:"pointer"}}
                            />
                            <span
                              onClick={() => editRotation({ [axis]: 0 })}
                              title="Click to reset"
                              style={{...S.sliderVal,width:52,cursor:"pointer"}}
                            >{value.toFixed(0)}°</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                    {(() => {
                      // Dynamic slot (per ACCESSORY_CATEGORY_TO_SLOT) —
                      // real options come entirely from the backend's
                      // live scan of public/media/accessories/, "None"
                      // still always first. Everything else keeps using
                      // the existing static placeholder list, unchanged.
                      const options = dynamicList
                        ? [{ label: "None", glbUrl: null, thumbnailUrl: null }, ...dynamicList.map(item => ({ label: item.displayName, glbUrl: item.glbUrl, thumbnailUrl: item.thumbnailUrl }))]
                        : ACCESSORY_SCHEMA[activeSlot.region][activeSlot.slot].map(label => ({ label, glbUrl: null, thumbnailUrl: null }));

                      return options.map(({ label, glbUrl, thumbnailUrl }) => {
                        const selected = accessories[activeSlot.region][activeSlot.slot] === label;
                        return (
                          <div key={label}
                            onClick={()=>{
                              setAccessories(prev=>({...prev, [activeSlot.region]: {...prev[activeSlot.region], [activeSlot.slot]: label}}));
                              // Any dynamic slot (per
                              // ACCESSORY_CATEGORY_TO_SLOT) feeds the 3D
                              // viewport — harmless no-op for every
                              // other, still-placeholder slot, since
                              // dynamicList is only truthy for slots
                              // with real backend data.
                              if (dynamicList) {
                                // Session 103 — clicking the ALREADY-SELECTED
                                // garment is navigation to its detail view,
                                // NOT a re-pick: skip the state write and the
                                // fresh-fit reset entirely (found live:
                                // re-clicking made the garment vanish and
                                // reload while its fit zeroed — confusing and
                                // wrong). Fresh-fit applies to CHANGES only.
                                if (stripV(selectedAccessoryGlbUrls[slotKey]) === stripV(glbUrl)) {
                                  if (glbUrl) { setScaleDetailSlot(slotKey); setActivePart(null); }
                                  return;
                                }
                                setSelectedAccessoryGlbUrls(prev => ({ ...prev, [slotKey]: stripV(glbUrl) }));
                                // Session 102 — picking a garment = a FRESH fit:
                                // shrinkwrap against THIS body + neutral manual
                                // sliders. Without this, the slot's previous
                                // manual scale (possibly tuned for another
                                // character entirely) silently carried onto the
                                // new pick (found live: Elina's shirt arriving
                                // in Benny's size).
                                resetSlotFit(slotKey);
                                // Real accessory picked (not "None") —
                                // flow straight into the scale-detail
                                // view for it. Picking "None" has
                                // nothing to scale-adjust, so it stays
                                // on this panel instead.
                                if (glbUrl) { setScaleDetailSlot(slotKey); setActivePart(null); }
                              }
                              // Deliberately stays on this panel rather than
                              // auto-returning to the tree — with the
                              // viewport always visible now, this lets
                              // someone try a few options in a row and
                              // compare, tapping ← only when they're
                              // actually done with this slot.
                            }}
                            style={{border:selected?"1px solid #1a1814":"1px solid rgba(0,0,0,0.1)",background:selected?"rgba(26,24,20,0.04)":"none",borderRadius:8,padding:"16px 8px",textAlign:"center",cursor:"pointer"}}
                          >
                            {thumbnailUrl ? (
                              <img src={thumbnailUrl} alt={label} style={{width:96,height:96,borderRadius:6,objectFit:"cover",margin:"0 auto 8px",display:"block"}} />
                            ) : (
                              <div style={{width:96,height:96,borderRadius:6,background:"rgba(0,0,0,0.06)",margin:"0 auto 8px"}} />
                            )}
                            <div style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:10,color:"#1a1814"}}>{label}</div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                  )}
                </div>
                );
              })() : (<>
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:16}}>
                  {Object.keys(ACCESSORY_SCHEMA).map(region=>(
                    <button key={region} onClick={()=>setActiveAccessoryRegion(region)} style={{
                      padding:"7px 11px", fontFamily:"'DM Mono',monospace", fontSize:10,
                      border:"1px solid " + (activeAccessoryRegion===region ? "#b05c08" : "rgba(199,180,140,0.25)"),
                      borderRadius:8, background: activeAccessoryRegion===region ? "rgba(176,92,8,0.12)" : "transparent",
                      color: activeAccessoryRegion===region ? "#b05c08" : "#6b6760", cursor:"pointer",
                    }}>{region}</button>
                  ))}
                </div>
                {[ACCESSORY_SCHEMA[activeAccessoryRegion] ? activeAccessoryRegion : "Torso"].map(region=>{
                  const overridden = OVERRIDDEN_BY_FULL_OUTFIT.includes(region) && accessories["Full Outfit"]?.["Full Outfit"] !== "None";
                  return (
                    <div key={region} style={{marginBottom:20}}>
                      <div style={{marginLeft:2}}>
                        {Object.keys(ACCESSORY_SCHEMA[region]).map(slot=>{
                          // Session 108 — occluded slots stay selectable-in-data but
                          // read as hidden: same dimmed treatment as the Full Outfit
                          // override, still clickable so the tint/choice can be edited
                          // even while covered.
                          const occludingOuter = Object.entries(OCCLUDES).find(([outer, inner]) => inner === `${region}.${slot}` && selectedAccessoryGlbUrls[outer])?.[0];
                          const val = overridden ? "Overridden by Full Outfit" : accessories[region][slot];
                          return (
                            <div key={slot}
                              onClick={()=>{ if (!overridden) setActiveSlot({region, slot}); }}
                              style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 12px",borderRadius:8,border:"1px solid rgba(0,0,0,0.1)",marginBottom:6,cursor:overridden?"default":"pointer",opacity:overridden?0.5:(occludingOuter?0.55:1)}}
                              onMouseEnter={e=>{ if (!overridden) e.currentTarget.style.borderColor="#c9973a"; }}
                              onMouseLeave={e=>{ e.currentTarget.style.borderColor="rgba(0,0,0,0.1)"; }}
                            >
                              <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:9,letterSpacing:"0.06em",textTransform:"uppercase",color:"#a8a5a0"}}>{slot}{occludingOuter && !overridden ? " · hidden under outerwear" : ""}</span>
                              <span style={{fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:12,color:"#1a1814"}}>{val}{!overridden && " ›"}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </>)}
    </div>
  );
}
