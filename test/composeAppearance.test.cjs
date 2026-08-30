// Run: node test/composeAppearance.test.cjs   (exits non-zero on failure)
//
// Test composeAppearance against the REAL source in src/lib/appearance.js.
// The module is pure — no React, no JSX, no imports — so the whole file is
// evaluated with its `export` keywords stripped, rather than the fragile text
// slice this test used while the composer still lived inside
// ActorsEditorPage.jsx. If the file ever grows an import, the eval throws and
// that is a failure, not a skip: it would mean the composer is no longer
// something a plain node script can hold to account.
const fs = require("fs");
const path = require("path");
const SRC = path.join(__dirname, "..", "src", "lib", "appearance.js");
const text = fs.readFileSync(SRC, "utf8");

let compose, emptyFields;
try {
  const code = text.replace(/^export /gm, "");
  const evaluated = eval(code + "; ({ composeAppearance, emptyAppearanceFields })");
  compose = evaluated.composeAppearance;
  emptyFields = evaluated.emptyAppearanceFields;
} catch (err) {
  console.error("FAIL: could not evaluate src/lib/appearance.js —", err.message);
  process.exit(1);
}
if (typeof compose !== "function") {
  console.error("FAIL: src/lib/appearance.js does not export composeAppearance");
  process.exit(1);
}

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`      got:  ${JSON.stringify(got)}`); console.log(`      want: ${JSON.stringify(want)}`); }
}

// Empty in, empty out — an actor with no fields must not get a stray "."
check("empty", compose({}, "female"), "");

// Height phrasing: the reason the phrase table exists at all.
check("petite reads as petite, not 'petite height'",
  compose({ height: "petite" }, "female"), "Petite.");
check("average gets the noun",
  compose({ height: "average" }, "female"), "Average height.");
check("above average gets the noun",
  compose({ height: "above average" }, "male"), "Above average height.");

// Gender split: female fields must not leak into a male character and vice versa.
const both = { height: "tall", build: "athletic", bust: "full", physique: "muscular", shoulders: "broad" };
check("female block only", compose(both, "female"), "Tall, athletic build, full bust.");
check("male block only",   compose(both, "male"),   "Tall, athletic build, muscular physique, broad shoulders.");
check("neutral takes neither", compose(both, "neutral"), "Tall, athletic build.");

// height_dominance "average" is the no-op default and should not be stated.
check("average height dominance is silent",
  compose({ height_dominance: "average" }, "male"), "");
check("very tall dominance is stated",
  compose({ height_dominance: "very tall" }, "male"), "Very tall.");

// tension_markers "none" is the endpoint's own default and should not be stated.
check("tension 'none' is silent",
  compose({ tension_markers: "none" }, "female"), "");
check("real tension is stated",
  compose({ tension_markers: "jaw held tight" }, "female"), "Tension: jaw held tight.");

// The intimate fields must land LAST, outside the 150-char window another
// actor is shown. This is the ordering claim the panel makes in its comment.
const full = {
  height: "above average", build: "athletic", body_shape: "hourglass",
  figure: "curved", bust: "full", waist_hip_ratio: "high", legs: "long",
  hair: "dark brown, shoulder-length, wavy", eyes: "green, sharp",
  face: "oval, olive skin, strong jaw", notable: "scar over the left eyebrow",
  style: "tailored casual", grooming: "meticulous",
  presence: "warm", body_confidence: "high", tension_markers: "none",
  voice: "low and unhurried", sexual_presence: "direct", endowment: "n/a",
};
const prose = compose(full, "female");
console.log("\n--- full composition ---\n" + prose);
console.log(`\nlength: ${prose.length}`);
console.log(`first 150 (what another actor sees): ${JSON.stringify(prose.slice(0, 150))}\n`);
check("intimate fields fall outside the 150-char window",
  prose.slice(0, 150).includes("Sexual presence") || prose.slice(0, 150).includes("Endowment"), false);
check("the 150-char window carries the look (hair reaches it)",
  prose.slice(0, 150).includes("Hair:"), true);
check("sentence capitalisation", prose.startsWith("Above average height, athletic build,"), true);

// ── The three surfaces must agree on one field set ───────────────────────────
//
// The point of moving this module out of ActorsEditorPage.jsx was that the
// wizard, the editor and the server route all author the SAME map. Nothing
// about that is enforced by types here, so it is asserted.

// 1. Every key the server's generate/appearance JSON contract asks Haiku for
//    must exist in the empty map, or a generated value would land in a key the
//    editor never renders and the composer never reads — silently dropped.
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
const routeStart = serverSrc.indexOf("POST /api/generate/appearance");
const contract = serverSrc.slice(routeStart, routeStart + 4000);
const contractKeys = [...new Set([...contract.matchAll(/"([a-z_]+)":"/g)].map(m => m[1]))]
  .filter(k => k !== "gender" && k !== "type" && k !== "text");
const empty = emptyFields();
const missing = contractKeys.filter(k => !(k in empty));
check("every generate/appearance contract key exists in the field map",
  missing.join(",") || "none", "none");
check("the contract was actually found (not an empty match)",
  contractKeys.length > 10, true);

// 2. emptyAppearanceFields must hand back a FRESH object each call — it goes
//    straight into React state on two pages, and a shared one would leak one
//    character's look into the next.
const a = emptyFields();
a.hair = "leaked";
check("emptyAppearanceFields returns a fresh object", emptyFields().hair, "");

// 3. Neither page may define its own composer or its own field list again.
for (const page of ["CharacterWizard.jsx", "ActorsEditorPage.jsx"]) {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "pages", page), "utf8");
  check(`${page} imports the shared module`,
    /from "\.\.\/lib\/appearance\.js"/.test(src), true);
  check(`${page} does not redefine composeAppearance`,
    /function composeAppearance/.test(src), false);
}

process.exit(failed ? 1 : 0);
