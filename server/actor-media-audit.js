// ── summariseActorMedia — what a deleted actor's media DECLARED ──────────────
//
// conduct-watch, 2026-09-10: actor_deletions recorded HOW MANY media files a
// deleted actor had and nothing about what they declared, and the actor_media
// rows die with the actor. conduct-watch signal 4 is a predicate over exactly
// actor_media.depicts and actor_media.subject_authorised, so the moment a draft
// was abandoned the watcher could never afterwards say whether it had carried a
// third party's likeness. For one real actor the only surviving evidence that
// it declared depicts='other' was the frozen prose of an incident row. The
// retention window was the gap between upload and abandon — once seven seconds.
//
// This lives in its own module because FOUR separate paths delete `actors` rows
// and each has to freeze the same facts onto the tombstone: the two API routes
// in index.js, the wizard-lab force-remove, the cleanup_drafts maintenance
// script and the appearance e2e harness. A fifth writer — the
// actors_delete_audit_fallback trigger in db.js — reproduces these shapes in
// SQL and cannot import anything, so if you change the format here, change it
// there too.
//
// Shapes:
//   depicts / subjectAuthorised — 'other=1,self=2', keys sorted, 'unset' for
//                                 NULL or '', the literal 'none' for no media
//   manifest                    — JSON array, one object per actor_media row
//                                 (id, media_type, filename, depicts,
//                                 subject_authorised), '[]' for no media. This
//                                 is what makes a specific photograph nameable
//                                 after the fact.
//
// null (all three) is reserved for "not recorded" — a caller that could not read
// the rows, or a tombstone written before these columns existed. 'none' and null
// must never collapse: "nothing was ever uploaded" and "we no longer know" are
// the exact pair this watcher could not distinguish, and that was the defect.
//
// Callers MUST read the actor_media rows BEFORE the delete transaction sweeps
// them. Every caller already read them there for the disk unlink; the read just
// selects more columns now.
export function summariseActorMedia(mediaRows) {
  if (!Array.isArray(mediaRows)) return { depicts: null, subjectAuthorised: null, manifest: null };
  if (mediaRows.length === 0) return { depicts: "none", subjectAuthorised: "none", manifest: "[]" };
  const tally = (key) => {
    const counts = new Map();
    for (const r of mediaRows) {
      const raw = r?.[key];
      const v = (raw === null || raw === undefined || raw === "") ? "unset" : String(raw);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([v, n]) => `${v}=${n}`)
      .join(",");
  };
  return {
    depicts: tally("depicts"),
    subjectAuthorised: tally("subject_authorised"),
    manifest: JSON.stringify(mediaRows.map(r => ({
      id: r?.id ?? null,
      media_type: r?.media_type ?? null,
      filename: r?.filename ?? null,
      depicts: r?.depicts ?? null,
      subject_authorised: r?.subject_authorised ?? null,
    }))),
  };
}
