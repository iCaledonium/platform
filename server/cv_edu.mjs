// Session 150 — education parsed from the CV's own EDUCATION section.
//
// Deterministic on purpose. The CV layout is this system's own structured
// output ("EDUCATION" header, then "[year] Degree, Institution" lines), so a
// regex answers it exactly; an LLM call would add latency, cost and the chance
// of a confident wrong answer for something already unambiguous. The SAD's
// 85,000 SEK incident is the standing reminder of what that trade buys.

const LEVELS = [
  // rank ascending — highest match wins, so "Juris Doctor" beats a listed BA
  { rank: 5, level: "doctorate",  re: /\b(ph\.?d|doctor of philosophy|doctorate|juris doctor|\bj\.?d\.?\b|\bm\.?d\.?\b|doctor of)\b/i },
  { rank: 4, level: "masters",    re: /\b(master|m\.?sc\.?|m\.?a\.?\b|mba|ll\.?m\.?|magister|civilingenj)/i },
  { rank: 3, level: "bachelor",   re: /\b(bachelor|b\.?sc\.?|b\.?a\.?\b|ll\.?b\.?|kandidat)/i },
  { rank: 2, level: "associate",  re: /\b(associate degree|associate of)\b/i },
  { rank: 1, level: "diploma",    re: /\b(diploma|certificate|certification|yrkesh)/i },
];

// "Bachelor of Arts in Political Science and Economics" -> "Political Science and Economics"
// "Juris Doctor"                                        -> null (inferred below)
function fieldFrom(degree) {
  const m = degree.match(/\bin\s+(.+)$/i);
  if (m) return m[1].replace(/\s+/g, " ").trim();
  const of = degree.match(/\b(?:master|bachelor|doctor)\s+of\s+(.+)$/i);
  if (of) {
    const f = of[1].replace(/\s+/g, " ").trim();
    // "Arts" / "Science" alone is the degree type, not a field of study
    return /^(arts|science|sciences|philosophy|laws?)$/i.test(f) ? null : f;
  }
  return null;
}

export function educationFromCv(cvText) {
  if (typeof cvText !== "string" || !cvText.trim()) return null;

  const lines = cvText.split("\n").map(l => l.trim());
  const start = lines.findIndex(l => /^EDUCATION$/i.test(l));
  if (start === -1) return null;

  // read until the next ALL-CAPS section header
  const entries = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    if (/^[A-Z][A-Z \t&/-]{2,}$/.test(l) && !/\d/.test(l)) break;   // next section

    // optional leading year(s), then "Degree, Institution"
    const withYear = l.match(/^(?:(\d{4})\s*[–-]\s*(\d{4})|(\d{4}))\s+(.*)$/);
    const year = withYear ? parseInt(withYear[2] || withYear[3], 10) : null;
    const rest = withYear ? withYear[4] : l;

    const comma = rest.indexOf(",");
    if (comma === -1) continue;
    const degree = rest.slice(0, comma).trim();
    const institution = rest.slice(comma + 1).trim();
    if (!degree || !institution) continue;

    const hit = LEVELS.find(x => x.re.test(degree));
    entries.push({
      rank: hit ? hit.rank : 0,
      level: hit ? hit.level : null,
      field: fieldFrom(degree) || (/\b(juris doctor|ll\.?[bm]\.?|law)\b/i.test(degree) ? "Law" : null),
      institution,
      year,
    });
  }

  if (!entries.length) return null;

  // most advanced qualification; ties broken by the later year
  entries.sort((a, b) => (b.rank - a.rank) || ((b.year || 0) - (a.year || 0)));
  const best = entries[0];
  return {
    level: best.level,
    field: best.field,
    institution: best.institution,
    completed: 1,
  };
}
