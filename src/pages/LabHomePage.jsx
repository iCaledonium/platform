import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// ── Test Lab · Home ──────────────────────────────────────────────────────────
//
// The index of every test case the lab offers. Each case is a page under
// /lab/<subject>/<place>/<situation>; adding one is a single entry here plus
// its route in App.jsx — nginx serves the whole /lab prefix already.

const GOLD = "rgba(201,151,58,";

// The two cross-bench surfaces. They are not test cases themselves — one
// runs every case, the other holds what the cases found — so they are
// listed apart from the benches below.
const BOARDS = [
  {
    path: "/lab/home/testmanager",
    title: "Test manager",
    blurb: "Where test cases are administered and run. Build suites from individual cases or " +
      "whole categories, give a suite the world it runs against, then run it by hand or on a " +
      "schedule. Read-only: nothing here authors a past or wipes a memory, so a suite is safe " +
      "against a world somebody is working in, and safe unattended.",
  },
  {
    path: "/lab/home/incidents",
    title: "Incidents",
    blurb: "Everything every test case and every routine found, fingerprinted so a case that " +
      "fails on ninety nightly runs is one incident seen ninety times \u2014 never ninety rows. " +
      "Closes itself when the case comes back green.",
  },
  {
    path: "/lab/home/resolutionmanager",
    title: "Resolution manager",
    blurb: "Always on. Works the unresolved list itself \u2014 diagnoses, fixes, verifies, and " +
      "closes the incident, same authority and guardrails as the fault-triage routine. Idle " +
      "when there is nothing to do; flags an incident needs acknowledgement, with its own " +
      "note, the moment it cannot finish one safely alone.",
  },
  {
    path: "/lab/home/restartbroker",
    title: "Restart broker",
    blurb: "Every restart of the simulator or the platform goes through one lease at a time \u2014 " +
      "a hook denies the call outright to anyone not holding it. A session declares how long it " +
      "needs when it asks; a standalone daemon, outside any Claude session, grants the queue " +
      "head, reclaims the instant that window is up, and reclaims early on evidence a holder " +
      "never actually restarted. Read-only here \u2014 current lease, the queue, and the daemon's " +
      "own heartbeat.",
  },
];

const CASES = [
  {
    path: "/lab/actor/apartment/encounter",
    key: "encounter",
    subject: "Actor",
    place: "Apartment",
    situation: "Encounter",
    blurb: "The door pipeline — begin at knock, threshold, or inside. " +
      "Fixtures author her past; everything after the chosen stage is the production path.",
    live: true,
  },
  {
    path: "/lab/user/signup",
    key: "signup",
    subject: "User",
    place: "Signup",
    situation: "Creation",
    blurb: "The invite → enroll → org pipeline, walked through the production endpoints " +
      "with throwaway @lab.local people. Carries its own platform-side scorecard.",
    live: true,
  },
  {
    path: "/lab/user/signin",
    subject: "User",
    place: "Sign in",
    situation: "Session",
    blurb: "The door \u2014 TOTP, the session it mints, the desktop handoff, sign-out. " +
      "Walked server-side against a throwaway account, because a test login in your browser would sign YOU out.",
    live: true,
  },
  {
    path: "/lab/user/avatar",
    key: "avatar",
    subject: "User",
    place: "Avatar",
    situation: "Body",
    blurb: "Adopting a body and pushing it into your worlds — plus what the creation pipeline " +
      "leaves behind: model files, sizes, likeness photos, the age floor.",
    live: true,
  },
  {
    path: "/lab/character/share",
    key: "share",
    subject: "Character",
    place: "Sharing",
    situation: "Link",
    blurb: "The two ways a character leaves its org — a share link aimed at whoever holds the URL, " +
      "and the public gallery aimed at every signed-in account. Neither may carry \u201ccopy\u201d: " +
      "ownership only ever crosses by an act aimed at a known person.",
    live: true,
  },
  {
    path: "/lab/character/deploy",
    key: "deploy",
    subject: "Character",
    place: "Deploy",
    situation: "World",
    blurb: "Putting a character into a world. Asserts the outcome rather than the code path \u2014 what is standing in a world right now, and how old it is.",
    live: true,
  },
  {
    path: "/lab/character/wizard",
    key: "wizard",
    subject: "Character",
    place: "Wizard",
    situation: "Authoring",
    blurb: "Building and re-opening a character — the autosave, the rename, the discard. Everything the " +
      "wizard asks of the server it asks with a fetch that reports failure to a console, so this is where " +
      "a save that never happened stops looking like one. Carries its own scorecard.",
    live: true,
  },
  {
    path: "/lab/world/behavior",
    key: "behavior",
    subject: "World",
    place: "—",
    situation: "Behaviour",
    blurb: "The autonomous layer — ticks, activities, needs, thoughts. Nothing here can be forced: " +
      "take two samples with a clock between them and watch what the loop does on its own.",
    live: true,
  },
  {
    path: "/lab/world/transport/actor",
    key: "transport",
    subject: "Transport",
    place: "—",
    situation: "Actor",
    blurb: "Moving an actor from A to B — departure, mode, route, arrival. " +
      "Author the contract and the garage; never the journey. Carries its own scorecard.",
    live: true,
  },
];

export default function LabHomePage() {
  const navigate = useNavigate();
  // How many test cases each category holds. The catalogue is learned from
  // sweeps, so this is what the category actually returned rather than a
  // number anybody maintains. Silent on failure: this page renders signed
  // out and should carry on doing so.
  const [counts, setCounts] = useState({});
  useEffect(() => {
    fetch("/api/test/cases", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!j?.cases) return;
        const n = {};
        for (const c of j.cases) n[c.source] = (n[c.source] || 0) + 1;
        setCounts(n);
      }).catch(() => {});
  }, []);

  // The category list comes from the SERVER, not from CASES above. CASES was
  // the whole list, maintained by hand, and it went stale the moment three
  // routine categories were registered on 2026-09-05: they existed in
  // lab_categories and showed as chips on the incidents page, but this page
  // could not know about them. That is the same trap boardCoverage was written
  // to catch one layer down ("BENCHES is a hardcoded list of other people's
  // work, and on 2026-08-30 it went stale twice in one evening") — except
  // nothing was checking this copy at all.
  //
  // CASES is now a DETAIL map, not the list: it supplies the blurb, the page
  // path and the live flag for the categories it happens to know, keyed by the
  // name those fields already spell. A category the server reports and CASES
  // has never heard of still renders, which is the whole point.
  const [cats, setCats] = useState(null);
  const [benchPages, setBenchPages] = useState({});
  useEffect(() => {
    // Both are auth-gated and this page deliberately renders signed out, so a
    // failure here is silent and falls back to CASES rather than blanking the
    // section.
    fetch("/api/test/categories", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (Array.isArray(j?.categories)) setCats(j.categories); })
      .catch(() => {});
    fetch("/api/test/benches", { credentials: "include" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (!Array.isArray(j?.benches)) return;
        const m = {};
        for (const b of j.benches) if (b.label) m[b.label] = { path: b.page, key: b.key };
        setBenchPages(m);
      }).catch(() => {});
  }, []);

  // A CASES entry's own subject/place/situation already join to exactly the
  // category name the server stores ("World · Behaviour", "Transport · Actor"),
  // so no second spelling is introduced here.
  const nameOf = (c) => [c.subject, c.place, c.situation].filter(x => x && x !== "\u2014").join(" \u00b7 ");
  const detailByName = Object.fromEntries(CASES.map(c => [nameOf(c), c]));

  const categoryCards = (cats || []).length
    ? cats.map(cat => {
        const d = detailByName[cat.name] || {};
        const b = benchPages[cat.name] || {};
        return {
          name: cat.name,
          path: d.path || b.path || null,
          key: d.key || b.key,
          blurb: d.blurb || cat.description || null,
          // Only a category we can actually navigate to is clickable. A
          // server-side category with no page is still listed — its absence
          // would be the bug — it just does not pretend to be a link.
          live: d.live !== undefined ? d.live && !!(d.path || b.path) : !!(d.path || b.path),
        };
      })
    : CASES.map(c => ({ name: nameOf(c), path: c.path, key: c.key, blurb: c.blurb, live: c.live }));

  const label = { fontSize: 10, letterSpacing: ".16em", textTransform: "uppercase",
    color: "rgba(255,255,255,.4)" };

  const card = (live) => ({
    display: "flex", flexDirection: "column", gap: 8, padding: "16px 18px",
    background: live ? "rgba(255,255,255,.025)" : "rgba(255,255,255,.012)",
    border: `0.5px solid ${live ? "rgba(255,255,255,.1)" : "rgba(255,255,255,.05)"}`,
    borderRadius: 6, cursor: live ? "pointer" : "default",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#0d0c0a", fontFamily: "'DM Sans',system-ui,sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "14px 24px", background: "#080706", borderBottom: "0.5px solid rgba(255,255,255,.08)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: "'Cormorant Garamond',Georgia,serif", fontSize: 21, color: "rgba(255,255,255,.92)" }}>Test Lab</span>
          <span style={{ ...label, color: GOLD + ".65)" }}>owner's tool</span>
        </div>
        <button onClick={() => navigate("/home")}
          style={{ padding: "8px 16px", background: "transparent", border: "0.5px solid rgba(255,255,255,.14)",
            borderRadius: 4, cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
            fontSize: 11, color: "rgba(255,255,255,.6)" }}>Close</button>
      </div>

      <div style={{ maxWidth: 880, margin: "0 auto", padding: "24px 24px 60px",
        display: "flex", flexDirection: "column", gap: 24 }}>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={label}>Across all test cases</span>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {BOARDS.map(b => (
              <div key={b.path} onClick={() => navigate(b.path)}
                style={{ ...card(true), flex: "1 1 340px" }}>
                <span style={{ fontSize: 13.5, color: GOLD + ".95)" }}>{b.title}</span>
                <span style={{ fontSize: 11, lineHeight: 1.6, color: "rgba(255,255,255,.45)" }}>{b.blurb}</span>
                <span style={{ fontSize: 9.5, fontFamily: "ui-monospace,monospace",
                  color: "rgba(255,255,255,.3)" }}>{b.path}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span style={label}>Categories</span>
          <span style={{ fontSize: 10.5, lineHeight: 1.6, color: "rgba(255,255,255,.35)", marginTop: -4 }}>
            Each holds many test cases. Build suites from them — or from individual cases — on the
            <span onClick={() => navigate("/lab/home/testmanager")}
              style={{ color: GOLD + ".85)", cursor: "pointer" }}> test manager</span>.
          </span>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {categoryCards.map(c => (
              <div key={c.name} onClick={() => c.live && c.path && navigate(c.path)} style={card(c.live)}>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                  <span style={{ fontSize: 13.5, color: c.live ? GOLD + ".95)" : "rgba(255,255,255,.3)" }}>
                    {c.name}
                  </span>
                  <span style={{ display: "flex", gap: 10, alignItems: "baseline", flexShrink: 0 }}>
                    {counts[c.key] != null && (
                      <span style={{ ...label, fontSize: 9, color: "rgba(255,255,255,.45)" }}>
                        {counts[c.key]} test case{counts[c.key] === 1 ? "" : "s"}
                      </span>
                    )}
                    <span style={{ ...label, fontSize: 9,
                      color: c.live ? "rgba(150,210,150,.75)" : "rgba(255,255,255,.25)" }}>
                      {c.live ? "live" : "planned"}
                    </span>
                  </span>
                </div>
                <span style={{ fontSize: 11, lineHeight: 1.6,
                  color: c.live ? "rgba(255,255,255,.45)" : "rgba(255,255,255,.22)" }}>{c.blurb}</span>
                <span style={{ fontSize: 9.5, fontFamily: "ui-monospace,monospace",
                  color: c.live ? "rgba(255,255,255,.3)" : "rgba(255,255,255,.15)" }}>
                  {c.path || "no page \u2014 its incidents are on the incidents board"}</span>
              </div>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
