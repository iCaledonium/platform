// ── /share/:token — claim a character somebody shared with you ────────────────
//
// Session 158. Reached by anybody holding the link, including people in another
// organisation entirely and people with no session at all.
//
// This page is registered in App.jsx's SIGNED-OUT route tree and its path is
// added to `isAuthPage`, which is not cosmetic: the signed-in shell opens an SSE
// stream and polls notifications on mount, and both 401 in a loop behind a page
// whose whole job is to work for a stranger. That is the exact trap the /invite
// comment in App.jsx warns about. So this component does its own auth handling:
// a 401 from the preview is an ordinary, expected state here, not an error.

import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";

const PERM_COPY = {
  read: { title: "View this character",
          body:  "You will be able to open her profile and see how she is put together. You cannot deploy her into a world or edit her." },
  use:  { title: "Use this character",
          body:  "You will be able to open her profile and deploy her into a world you own. The original stays with her creator — the copy that lives in your world is yours to direct, and your changes never travel back." },
};

const shell = { minHeight:"100vh", background:"#faf8f4", display:"flex", alignItems:"center", justifyContent:"center", padding:24 };
const card  = { width:"100%", maxWidth:520, background:"#fff", border:"1px solid #e8e4dc", borderRadius:16, padding:"36px 34px", boxShadow:"0 1px 3px rgba(0,0,0,.04)" };
const serif = { fontFamily:"'Cormorant Garamond',Georgia,serif" };
const sans  = { fontFamily:"'DM Sans',system-ui,sans-serif" };
const eyebrow = { ...sans, fontSize:9, letterSpacing:".15em", textTransform:"uppercase", color:"#a8a5a0", marginBottom:12 };
const btn = { ...sans, fontSize:11, letterSpacing:".06em", textTransform:"uppercase", padding:"12px 22px", borderRadius:10, background:"#1a1814", color:"#faf8f4", border:"none", cursor:"pointer" };

function Frame({ children }) {
  return <div style={shell}><div style={card}>{children}</div></div>;
}

function Message({ eyebrowText, title, body, action }) {
  return (
    <Frame>
      <div style={eyebrow}>{eyebrowText}</div>
      <div style={{ ...serif, fontSize:27, color:"#1a1814", lineHeight:1.25 }}>{title}</div>
      {body && <div style={{ ...sans, fontSize:14, color:"#6b6760", lineHeight:1.6, marginTop:14 }}>{body}</div>}
      {action && <div style={{ marginTop:26 }}>{action}</div>}
    </Frame>
  );
}

export default function ClaimSharePage() {
  const { token } = useParams();
  const navigate  = useNavigate();
  const [preview, setPreview] = useState(null);
  const [status,  setStatus]  = useState("loading"); // loading | ready | signedout | gone | claiming | done
  const [error,   setError]   = useState(null);
  const [result,  setResult]  = useState(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/share/${encodeURIComponent(token)}`)
      .then(async r => {
        if (!live) return;
        if (r.status === 401) { setStatus("signedout"); return; }
        const body = await r.json().catch(() => ({}));
        if (!r.ok) { setError(body.error || "This share link is not valid."); setStatus("gone"); return; }
        setPreview(body);
        setStatus("ready");
      })
      .catch(() => { if (live) { setError("Could not reach the server."); setStatus("gone"); } });
    return () => { live = false; };
  }, [token]);

  async function claim() {
    setStatus("claiming");
    setError(null);
    try {
      const r = await fetch(`/api/share/${encodeURIComponent(token)}/claim`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) { setError(body.error || "Could not claim this character."); setStatus("ready"); return; }
      setResult(body);
      setStatus("done");
    } catch {
      setError("Could not reach the server.");
      setStatus("ready");
    }
  }

  if (status === "loading") {
    return <Message eyebrowText="Shared character" title="Opening…" />;
  }

  // Signed out. Stash where we were so LoginPage can bring them back here
  // instead of dropping them on /home with the token lost from the URL.
  if (status === "signedout") {
    return (
      <Message
        eyebrowText="Shared character"
        title="Sign in to see what you have been sent"
        body="Somebody has shared a character with you. Characters belong to accounts, so you need to be signed in to accept one. You will come straight back here."
        action={
          <button style={btn} onClick={() => {
            try { sessionStorage.setItem("anima_after_login", `/share/${token}`); } catch { /* private mode */ }
            window.location.href = "/login";
          }}>Sign in</button>
        }
      />
    );
  }

  if (status === "gone") {
    return <Message eyebrowText="Shared character" title="This link cannot be opened" body={error} />;
  }

  if (status === "done") {
    return (
      <Message
        eyebrowText="Shared character"
        title={result?.already_had ? `You already had ${result.name}` : `${result?.name} is now in your gallery`}
        body={result?.already_had
          ? "Nothing changed — this link offered no more than you already hold."
          : `She appears under "Shared with you". ${result?.permission === "use"
              ? "You can deploy her into a world you own."
              : "You can view her profile."}`}
        action={<button style={btn} onClick={() => navigate("/actors")}>Go to characters</button>}
      />
    );
  }

  // status === "ready" | "claiming"
  const p = preview;
  const dead = p.state !== "active";
  const deadCopy = {
    revoked:   "The person who shared this has revoked the link.",
    expired:   "This link has expired. Ask for a new one.",
    exhausted: "This link has already been claimed by as many people as it allows.",
  }[p.state];

  if (p.is_owner) {
    return <Message eyebrowText="Shared character" title={`${p.actor.name} is already yours`}
                    body="This is one of your own characters, so there is nothing here to accept."
                    action={<button style={btn} onClick={() => navigate("/actors")}>Go to characters</button>} />;
  }
  if (dead) {
    return <Message eyebrowText="Shared character" title="This link is no longer live" body={deadCopy} />;
  }

  const copy = PERM_COPY[p.permission] ?? PERM_COPY.read;
  const already = p.already_have;

  return (
    <Frame>
      <div style={eyebrow}>{p.shared_by ? `${p.shared_by} shared a character with you` : "Shared character"}</div>

      <div style={{ display:"flex", gap:16, alignItems:"center", marginBottom:24 }}>
        {p.actor.photo_url && (
          <img src={p.actor.photo_url} alt=""
               style={{ width:72, height:72, borderRadius:12, objectFit:"cover", border:"1px solid #e8e4dc" }} />
        )}
        <div>
          <div style={{ ...serif, fontSize:28, color:"#1a1814", lineHeight:1.15 }}>{p.actor.name}</div>
          <div style={{ ...sans, fontSize:12, color:"#a8a5a0", marginTop:5 }}>
            {[p.actor.age, p.actor.gender, p.actor.occupation].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>

      <div style={{ ...sans, fontSize:13, color:"#1a1814", fontWeight:500, marginBottom:6 }}>{copy.title}</div>
      <div style={{ ...sans, fontSize:13, color:"#6b6760", lineHeight:1.65 }}>{copy.body}</div>

      {already && (
        <div style={{ ...sans, fontSize:12, color:"#6b6760", background:"#f4f1ea", border:"1px solid #e8e4dc",
                      borderRadius:9, padding:"10px 12px", marginTop:16 }}>
          You already have <strong>{already}</strong> on this character.
          {already === p.permission ? " Accepting changes nothing." : " Accepting will raise it."}
        </div>
      )}

      {error && <div style={{ ...sans, fontSize:12, color:"#a8392f", marginTop:16 }}>{error}</div>}

      <div style={{ display:"flex", alignItems:"center", gap:14, marginTop:26 }}>
        <button style={{ ...btn, opacity: status === "claiming" ? .4 : 1 }}
                disabled={status === "claiming"} onClick={claim}>
          {status === "claiming" ? "…" : "Accept"}
        </button>
        <button style={{ ...sans, fontSize:12, color:"#a8a5a0", background:"none", border:"none", cursor:"pointer" }}
                onClick={() => { window.location.href = "/home"; }}>Not now</button>
      </div>
    </Frame>
  );
}
