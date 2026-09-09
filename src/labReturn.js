// A screen opened FROM a bench carries `?lab=<name>` (the same stamp that
// lets the watcher follow). Closing that screen should return you to the
// bench you came from — that is where the run was configured and where the
// next one starts. Without this, finishing a lab run drops you on /home or
// the character gallery and the loop is broken by its own exit.
//
// Returns null for an unstamped visit, so a real user's Close is untouched.

const LAB_PATHS = {
  wizard:    "/lab/character/wizard",
  avatar:    "/lab/user/avatar",
  transport: "/lab/world/transport/actor",
  behavior:  "/lab/world/behavior",
  // The encounter bench stamps the STAGE it built, not its own name.
  knock:     "/lab/actor/apartment/encounter",
  threshold: "/lab/actor/apartment/encounter",
  inside:    "/lab/actor/apartment/encounter",
};

export function labReturnPath(search) {
  try {
    const raw = search !== undefined ? search : window.location.search;
    const v = new URLSearchParams(raw).get("lab");
    if (!v) return null;
    // Stamped with something we do not recognise: the index still beats /home.
    return LAB_PATHS[v] || "/lab/home";
  } catch { return null; }
}
