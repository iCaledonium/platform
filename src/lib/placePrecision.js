// ── Session 150 — a street is not an address ─────────────────────────────────
//
// Google Places returns ["geocode","route"] for "Narvavägen, Stockholm" and
// ["geocode","street_address"] for "Narvavägen 34B". Both are pickable
// predictions with a real place_id, and every home picker in the app used to
// throw `types` away, so the two arrived at the UI as indistinguishable
// strings. Picking the road registered a whole street as somebody's residence;
// re-picking the same flat WITH the house number later yielded a DIFFERENT
// place_id, and the simulator — correctly, since it keys on place_id — created
// a second apartment. That is where TEST WORLD ended up with two Narvavägen
// flats and one tenant.
//
// `premise` and `subpremise` are accepted alongside `street_address` because a
// named building and an individual flat within one are both places a person can
// live. Verified against the live Details API: the ghost returns ["route"],
// 34B returns ["street_address"], 32B returns ["street_address","subpremise"].
export const HOME_PRECISE_TYPES = ["street_address", "premise", "subpremise"];

// Missing or empty types means "we were not told" — a value saved before this
// existed, or a source that does not report it. Those pass here on purpose: the
// deploy route re-checks against Google itself and is the authoritative gate,
// so the UI stays lenient about what it cannot know and strict about what it
// can. Anything that DID report its types must name a dwelling.
export function isPreciseHome(types) {
  if (!Array.isArray(types) || types.length === 0) return true;
  return types.some(t => HOME_PRECISE_TYPES.includes(t));
}

export const IMPRECISE_HOME_HINT = "street only — add a house number";
