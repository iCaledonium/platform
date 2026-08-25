// ── The lighting the user actually set ───────────────────────────────────────
//
// Session 152. Exposure, environment, key light, sun angle, ambient, rim and
// shadows are configured on the 3D character tab and persisted by
// ActorModelPanel in two places: localStorage for the browser that set them,
// and users.preferences.exploreDisplay for the account. Her apartment should
// not be lit by numbers invented in a different file — a door that opens onto a
// darker flat than the one you just finished lighting is a bug you cannot even
// report properly.
//
// The contract is copied here rather than imported, deliberately: this reads
// the same keys and applies them the same way, without pulling the editor or
// its viewer into a scene that has no editing in it.
//
// Keep these defaults identical to EXPLORE_DISPLAY_DEFAULTS in
// ActorModelPanel.jsx. If they drift, the same settings light two rooms
// differently and it looks like a rendering bug rather than a constant.
export const DISPLAY_DEFAULTS = {
  exposure: 1.0,
  envIntensity: 1.0,
  keyIntensity: 0.9,
  ambientIntensity: 0.25,
  rimIntensity: 0.3,
  shadows: false,
  sunAzimuth: 37,
  sunElevation: 45,
};

// The account's copy wins over the browser's, the same precedence the editor
// uses on mount. Neither is required: a viewer that refuses to light a room
// because a preferences fetch failed is worse than one lit by the defaults.
export async function loadDisplay({ signal } = {}) {
  let out = { ...DISPLAY_DEFAULTS };

  try {
    const local = JSON.parse(localStorage.getItem("anima_explore_display") || "null");
    if (local && typeof local === "object") out = { ...out, ...local };
  } catch {
    /* a browser with no storage still gets a lit room */
  }

  try {
    const r = await fetch("/api/me/preferences", { credentials: "include", signal });
    if (r.ok) {
      const stored = (await r.json())?.preferences?.exploreDisplay;
      if (stored && typeof stored === "object") out = { ...out, ...stored };
    }
  } catch (e) {
    if (e?.name !== "AbortError") {
      console.warn("[display] preferences unavailable — using the local copy:", e?.message || e);
    }
  }

  return out;
}

// Sun direction is an azimuth and an elevation on a sphere of radius 3.536,
// which is where the editor's original hardcoded (1.5, 2.5, 2.0) key light sat:
// the defaults 37°/45° reproduce it exactly. Same maths here so the same
// numbers mean the same light.
export function sunPosition({ sunAzimuth, sunElevation }) {
  const R = 3.536;
  const az = (sunAzimuth * Math.PI) / 180;
  const el = (sunElevation * Math.PI) / 180;
  return [R * Math.cos(el) * Math.sin(az), R * Math.sin(el), R * Math.cos(el) * Math.cos(az)];
}

export function applyDisplay(display, { renderer, scene, key, ambient, rim } = {}) {
  if (renderer) {
    renderer.toneMappingExposure = display.exposure;
    if (renderer.shadowMap.enabled !== display.shadows) {
      renderer.shadowMap.enabled = display.shadows;
      // three only recompiles a material when it is told to, so a shadow flip
      // has to touch every one of them or half the room keeps the old shader.
      scene?.traverse(o => {
        if (!o.isMesh || !o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; });
      });
    }
  }
  if (ambient) ambient.intensity = display.ambientIntensity;
  if (rim) rim.intensity = display.rimIntensity;
  if (key) {
    key.intensity = display.keyIntensity;
    key.position.set(...sunPosition(display));
  }
  if (scene && "environmentIntensity" in scene) scene.environmentIntensity = display.envIntensity;
}
