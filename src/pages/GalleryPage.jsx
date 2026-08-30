// ── /gallery — every character published to the platform ──────────────────────
//
// Session 159. The other half of sharing outward: a link is handed to particular
// people, this is listed for everyone signed in.
//
// A listing grants nothing. It offers, and the reader takes with Adopt — which
// is why every card carries the rung it is offering and, if you already hold
// something on that character, what you already have. Adopting writes an
// ordinary actor_shares row, so an adopted character then behaves exactly like
// one somebody shared with you by name.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

const S    = { fontFamily:"'DM Sans',system-ui,sans-serif" };
const SER  = { fontFamily:"'Cormorant Garamond',Georgia,serif" };

const PERM_STYLE = {
  read: { bg:"rgba(136,135,128,.1)", fg:"#5f5e5a", br:"rgba(136,135,128,.2)" },
  use:  { bg:"rgba(55,138,221,.1)",  fg:"#185FA5", br:"rgba(55,138,221,.22)" },
  copy: { bg:"rgba(99,153,34,.1)",   fg:"#3b6d11", br:"rgba(99,153,34,.2)"   },
};
const PERM_HELP = {
  read: "You can open her profile.",
  use:  "You can deploy her into a world you own.",
};

function ini(name = "") {
  return name.split(" ").filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
}

function Card({ a, onAdopt, busy }) {
  const navigate = useNavigate();
  const ps = PERM_STYLE[a.permission] || PERM_STYLE.read;
  // Holding something already is the interesting state: the button must not
  // offer a person something they have, and must not imply a downgrade.
  const have = a.already_have;
  const RANK = { read: 1, use: 2, copy: 3 };
  const covered = have && (RANK[have] ?? 99) >= (RANK[a.permission] ?? 0);

  return (
    <div style={{ background:"#fff", border:"1px solid #e8e4dc", borderRadius:14, padding:16,
                  display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ display:"flex", gap:12, alignItems:"center" }}>
        {a.photo_url
          ? <img src={a.photo_url} alt="" style={{ width:56, height:56, borderRadius:10, objectFit:"cover", border:"1px solid #e8e4dc", flexShrink:0 }} />
          : <div style={{ width:56, height:56, borderRadius:10, background:"rgba(176,92,8,.1)", color:"#854f0b",
                          display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, ...S, fontSize:15 }}>{ini(a.name)}</div>}
        <div style={{ minWidth:0 }}>
          <div style={{ ...SER, fontSize:21, color:"#1a1814", lineHeight:1.2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{a.name}</div>
          <div style={{ ...S, fontSize:11, color:"#a8a5a0", marginTop:3 }}>
            {[a.age, a.gender, a.occupation].filter(Boolean).join(" · ") || "—"}
          </div>
        </div>
      </div>

      {a.note && (
        <div style={{ ...S, fontSize:12.5, color:"#6b6760", lineHeight:1.55 }}>{a.note}</div>
      )}

      <div style={{ ...S, fontSize:11, color:"#a8a5a0" }}>
        by {a.owner_name}
      </div>

      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, marginTop:"auto", paddingTop:4 }}>
        <span title={PERM_HELP[a.permission]}
              style={{ ...S, fontSize:9, letterSpacing:".07em", padding:"3px 8px", borderRadius:5,
                       background:ps.bg, color:ps.fg, border:`1px solid ${ps.br}` }}>
          offers {a.permission}
        </span>

        {a.is_mine ? (
          <button onClick={() => navigate("/actors")}
            style={{ ...S, fontSize:11, color:"#a8a5a0", background:"none", border:"none", cursor:"pointer" }}>Yours</button>
        ) : covered ? (
          <span style={{ ...S, fontSize:11, color:"#3b6d11" }}>
            You have {have}
          </span>
        ) : (
          <button onClick={() => onAdopt(a)} disabled={busy}
            style={{ ...S, fontSize:11, letterSpacing:".06em", textTransform:"uppercase", padding:"8px 14px",
                     borderRadius:9, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer",
                     opacity: busy ? .4 : 1 }}>
            {have ? "Upgrade" : "Adopt"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function GalleryPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [q, setQ]         = useState("");
  const [busyId, setBusy] = useState(null);
  const [toast, setToast] = useState(null);
  const [error, setError] = useState(null);

  function load(query = "") {
    fetch(`/api/gallery${query ? `?q=${encodeURIComponent(query)}` : ""}`)
      .then(r => r.ok ? r.json() : [])
      .then(setItems)
      .catch(() => setItems([]));
  }
  useEffect(() => { load(); }, []);

  // Debounced so typing does not fire a query per keystroke.
  useEffect(() => {
    const t = setTimeout(() => load(q), 250);
    return () => clearTimeout(t);
  }, [q]);

  async function adopt(a) {
    setBusy(a.id); setError(null);
    try {
      const r = await fetch(`/api/gallery/${a.id}/adopt`, { method: "POST" });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { setError(b.error || "Could not adopt this character."); return; }
      setToast(b.already_had ? `You already had ${b.name}.` : `${b.name} is now in your characters.`);
      load(q);
    } finally { setBusy(null); }
  }

  return (
    <div style={{ minHeight:"100vh", background:"#faf8f4", padding:"36px 28px 60px" }}>
      <div style={{ maxWidth:1080, margin:"0 auto" }}>

        <div style={{ display:"flex", alignItems:"flex-end", justifyContent:"space-between", gap:16, marginBottom:6, flexWrap:"wrap" }}>
          <div>
            <div style={{ ...S, fontSize:9, letterSpacing:".15em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:8 }}>Gallery</div>
            <div style={{ ...SER, fontSize:34, color:"#1a1814", lineHeight:1.1 }}>Characters people have published</div>
          </div>
          <button onClick={() => navigate("/actors")}
            style={{ ...S, fontSize:11, letterSpacing:".06em", textTransform:"uppercase", color:"#6b6760",
                     background:"none", border:"1px solid rgba(0,0,0,.12)", borderRadius:9, padding:"9px 15px", cursor:"pointer" }}>
            My characters
          </button>
        </div>

        <div style={{ ...S, fontSize:13, color:"#6b6760", lineHeight:1.6, maxWidth:620, marginBottom:22 }}>
          Anyone on the platform can list a character here, whichever organisation they belong to.
          A listing is an offer, not a hand-over — adopting one gives you what it says it gives you,
          and the character stays with whoever made her.
        </div>

        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search by name, occupation or note…"
          style={{ ...S, fontSize:13, width:"100%", maxWidth:380, padding:"10px 13px", borderRadius:10,
                   border:"1px solid rgba(0,0,0,.1)", background:"#fff", marginBottom:22 }} />

        {toast && (
          <div style={{ ...S, fontSize:12.5, color:"#3b6d11", background:"rgba(99,153,34,.08)",
                        border:"1px solid rgba(99,153,34,.2)", borderRadius:10, padding:"10px 13px", marginBottom:16 }}>
            {toast} <button onClick={() => navigate("/actors")} style={{ ...S, fontSize:12.5, color:"#3b6d11", background:"none", border:"none", cursor:"pointer", textDecoration:"underline", padding:0 }}>See it</button>
          </div>
        )}
        {error && <div style={{ ...S, fontSize:12.5, color:"#c0392b", marginBottom:16 }}>{error}</div>}

        {items === null ? (
          <div style={{ ...S, fontSize:13, color:"#a8a5a0" }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ ...S, fontSize:13, color:"#a8a5a0", lineHeight:1.6, maxWidth:520 }}>
            {q
              ? "Nothing here matches that."
              : "Nobody has published a character yet. You can publish one of yours from the share dialog on your characters page."}
          </div>
        ) : (
          <div style={{ display:"grid", gap:14, gridTemplateColumns:"repeat(auto-fill, minmax(268px, 1fr))" }}>
            {items.map(a => <Card key={a.id} a={a} onAdopt={adopt} busy={busyId === a.id} />)}
          </div>
        )}
      </div>
    </div>
  );
}
