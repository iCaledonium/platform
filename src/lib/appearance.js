// ── The structured appearance field set, and the prose composer ───────────────
//
// Shared because TWO surfaces author this and they must agree on one
// representation:
//
//   CharacterWizard.jsx   Appearance step (step 1). Fills the fields from the
//                         reference photos via POST /api/generate/appearance,
//                         then composes.
//   ActorsEditorPage.jsx  Appearance panel. Hand-authoring and refinement.
//
// Both write the same two columns:
//
//   actors.appearance         Prose, and the ONLY field the simulator reads.
//                             actor_meeting_runner.ex:562 slices it to 150
//                             characters as what the other person sees across
//                             from them, and hedra_client.ex:487 feeds it to
//                             the video prompt builder. A JSON blob written
//                             here would reach an LLM as a JSON blob.
//   actors.appearance_fields  The structured map, so both surfaces round-trip
//                             instead of trying to re-parse their own prose.
//
// The prose is composed from the fields until an author edits it by hand;
// after that it is theirs and composition stops, which `_auto: false` records.
// The alternative — silently overwriting a hand-written description on the next
// dropdown change — is exactly the failure that flag exists to prevent. Both
// surfaces honour it, so taking the prose over in the wizard survives into the
// editor and back.
//
// The field set is not invented here: it is the JSON contract that
// POST /api/generate/appearance (server/index.js:6581) already asks Haiku for,
// including its gender split, plus the three manual-only ones Haiku is never
// asked for (voice, sexual_presence, endowment).
//
// This lived inside ActorsEditorPage.jsx until the wizard needed it too.
// Importing a page module from another page module to get at one pure function
// would have pulled the whole editor — DeployWizardModal, ActorModelPanel and
// their three.js tail — into the wizard's chunk, so it moved here instead,
// beside money.js and placePrecision.js.

export const APP_SELECTS = {
  height:           ["tall","above average","average","petite","short"],
  build:            ["slim","lean","athletic","curvy","full-figured","stocky","muscular"],
  body_shape:       ["hourglass","pear","apple","rectangle","inverted triangle"],
  presence:         ["commanding","warm","understated","magnetic","reserved"],
  body_confidence:  ["high","moderate","low"],
  grooming:         ["meticulous","natural","minimal","casual"],
  bust:             ["small","average","full","large"],
  figure:           ["straight","slightly curved","curved","very curved"],
  waist_hip_ratio:  ["low","average","high"],
  legs:             ["short","average","long","athletic"],
  physique:         ["slim","average","toned","muscular","heavy"],
  shoulders:        ["narrow","average","broad","very broad"],
  height_dominance: ["average","tall","very tall"],
};

// The frame keys that only apply to one gender, in the order both surfaces show
// them. Everything not listed here applies to everyone.
export const FEMALE_FRAME = ["bust","figure","waist_hip_ratio","legs"];
export const MALE_FRAME   = ["physique","shoulders","height_dominance"];

// A fresh, fully-keyed empty map. A FUNCTION, not a shared constant, for the
// same reason defaultAccessories() is one: callers put it straight into state
// and an accidentally shared object would leak one character's look into the
// next. Every key is present and empty on purpose — CharacterWizard's draft
// loader restores ABSOLUTE (absence means CLEARED, never "keep the last
// character's"), and that law needs a complete map to clear against.
export const emptyAppearanceFields = () => ({
  // General — Haiku fills
  height:"", build:"", body_shape:"", hair:"", eyes:"", face:"", style:"", notable:"",
  presence:"", body_confidence:"", grooming:"", tension_markers:"",
  // Women — Haiku fills
  bust:"", figure:"", waist_hip_ratio:"", legs:"",
  // Men — Haiku fills
  physique:"", shoulders:"", height_dominance:"",
  // Manual only — never in the generate/appearance contract
  voice:"", sexual_presence:"", endowment:"",
});

// "tall build" reads fine, "petite height" does not — so height gets a phrase
// table rather than a suffix.
const HEIGHT_PHRASE = { "tall":"tall", "above average":"above average height", "average":"average height", "petite":"petite", "short":"short" };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

export function composeAppearance(f, gender) {
  const out = [];
  const frame = [];
  if (f.height)     frame.push(HEIGHT_PHRASE[f.height] || f.height);
  if (f.build)      frame.push(`${f.build} build`);
  if (f.body_shape) frame.push(`${f.body_shape} figure`);
  if (gender === "female") {
    if (f.figure)          frame.push(`${f.figure} silhouette`);
    if (f.bust)            frame.push(`${f.bust} bust`);
    if (f.waist_hip_ratio) frame.push(`${f.waist_hip_ratio} waist-to-hip ratio`);
    if (f.legs)            frame.push(`${f.legs} legs`);
  } else if (gender === "male") {
    if (f.physique)  frame.push(`${f.physique} physique`);
    if (f.shoulders) frame.push(`${f.shoulders} shoulders`);
    if (f.height_dominance && f.height_dominance !== "average") frame.push(f.height_dominance);
  }
  if (frame.length) out.push(cap(frame.join(", ")) + ".");
  if (f.hair)    out.push(`Hair: ${f.hair}.`);
  if (f.eyes)    out.push(`Eyes: ${f.eyes}.`);
  if (f.face)    out.push(`Face: ${f.face}.`);
  if (f.notable) out.push(`Notable: ${f.notable}.`);
  const manner = [];
  if (f.style)    manner.push(`dresses ${f.style}`);
  if (f.grooming) manner.push(`${f.grooming} grooming`);
  if (manner.length) out.push(cap(manner.join(", ")) + ".");
  const air = [];
  if (f.presence)        air.push(`${f.presence} presence`);
  if (f.body_confidence) air.push(`${f.body_confidence} body confidence`);
  if (air.length) out.push(cap(air.join(", ")) + ".");
  if (f.tension_markers && f.tension_markers !== "none") out.push(`Tension: ${f.tension_markers}.`);
  if (f.voice) out.push(`Voice: ${f.voice}.`);
  // Last on purpose. The 150-character window another actor is shown should
  // carry the look, not this.
  if (f.sexual_presence) out.push(`Sexual presence: ${f.sexual_presence}.`);
  if (f.endowment)       out.push(`Endowment: ${f.endowment}.`);
  return out.join(" ");
}
