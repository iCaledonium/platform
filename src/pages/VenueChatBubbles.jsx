import { useState, useRef, useEffect } from "react";

const font = "'DM Sans', system-ui, sans-serif";

// ── Venue feed bubble (bottom right, always present) ─────────────────────────

function VenueFeedBubble({ chat, onSend, onToggle }) {
  const [input, setInput] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    if (chat.open) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages, chat.open]);

  return (
    <div style={{
      width: 260, background: "rgba(18,16,14,.96)",
      border: "1px solid rgba(255,255,255,.1)",
      borderRadius: chat.open ? "12px 12px 0 0" : 12,
      overflow: "hidden", boxShadow: "0 8px 32px rgba(0,0,0,.5)"
    }}>
      <div onClick={onToggle} style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px", cursor: "pointer",
        background: chat.open ? "rgba(255,255,255,.06)" : "transparent",
        borderBottom: chat.open ? "1px solid rgba(255,255,255,.08)" : "none",
        userSelect: "none"
      }}>
        <div style={{ width:22, height:22, borderRadius:"50%", background:"rgba(181,148,90,.3)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, color:"rgba(181,148,90,.9)", flexShrink:0 }}>◈</div>
        <div style={{ flex:1, minWidth:0, fontFamily:font, fontSize:11, fontWeight:500, color:"rgba(255,255,255,.85)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{chat.name}</div>
        <div style={{ fontFamily:font, fontSize:11, color:"rgba(255,255,255,.3)" }}>{chat.open ? "−" : "+"}</div>
      </div>

      {chat.open && (
        <>
          <div style={{ overflowY:"auto", padding:"10px 12px", display:"flex", flexDirection:"column", gap:6, maxHeight:260, minHeight:120 }}>
            {chat.loading && chat.messages.length === 0 && (
              <div style={{ display:"flex", gap:4, padding:"4px 2px" }}>
                {[0,.15,.3].map((d,i) => <div key={i} style={{ width:5, height:5, borderRadius:"50%", background:"rgba(181,148,90,.6)", animation:`pulse .9s ${d}s infinite` }} />)}
              </div>
            )}
            {chat.messages.map((m, i) => (
              <div key={i}>
                {m.role === "assistant" && m.speaker && (
                  <div style={{ fontFamily:font, fontSize:9, color:"rgba(181,148,90,.7)", marginBottom:2, paddingLeft:2 }}>{m.speaker}</div>
                )}
                <div style={{ display:"flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div style={{ maxWidth:"85%", padding:"6px 10px", borderRadius: m.role==="user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px", background: m.role==="user" ? "rgba(181,148,90,.25)" : "rgba(255,255,255,.08)", color: m.role==="user" ? "rgba(255,255,255,.9)" : "rgba(255,255,255,.75)", fontSize:12, fontFamily:font, lineHeight:1.45 }}>{m.content}</div>
                </div>
              </div>
            ))}
            {chat.loading && chat.messages.length > 0 && (
              <div style={{ display:"flex", gap:4, padding:"4px 2px" }}>
                {[0,.15,.3].map((d,i) => <div key={i} style={{ width:5, height:5, borderRadius:"50%", background:"rgba(181,148,90,.6)", animation:`pulse .9s ${d}s infinite` }} />)}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
          {!chat.ended && (
            <div style={{ padding:"8px 10px", borderTop:"1px solid rgba(255,255,255,.06)", display:"flex", gap:6 }}>
              <input value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter" && !e.shiftKey && input.trim()) { onSend(input.trim()); setInput(""); } }}
                placeholder="Say something to the room…" disabled={chat.loading}
                style={{ flex:1, background:"rgba(255,255,255,.07)", border:"1px solid rgba(255,255,255,.1)", borderRadius:16, padding:"5px 10px", fontSize:11, fontFamily:font, color:"rgba(255,255,255,.85)", outline:"none" }} />
              <button onClick={() => { if(input.trim()) { onSend(input.trim()); setInput(""); } }}
                disabled={chat.loading || !input.trim()}
                style={{ background:"rgba(181,148,90,.6)", border:"none", borderRadius:16, padding:"5px 10px", fontSize:11, color:"#fff", cursor:"pointer", opacity: chat.loading || !input.trim() ? 0.4 : 1 }}>↑</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Private chat floating window ─────────────────────────────────────────────

function PrivateChatWindow({ chat, onSend, onClose, initialX, initialY }) {
  const [input, setInput]         = useState("");
  const [pos, setPos]             = useState({ x: initialX, y: initialY });
  const [minimized, setMinimized] = useState(false);
  const bottomRef                 = useRef(null);

  useEffect(() => {
    if (!minimized) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages, minimized]);

  function startDrag(e) {
    e.preventDefault();
    const startX = e.clientX - pos.x;
    const startY = e.clientY - pos.y;
    const onMove = e => setPos({ x: e.clientX - startX, y: e.clientY - startY });
    const onUp   = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div style={{
      position:"fixed", left:pos.x, top:pos.y, zIndex:1250,
      width:380, background:"rgba(18,16,14,.97)",
      border:"1px solid rgba(255,255,255,.12)", borderRadius:14,
      overflow:"hidden", boxShadow:"0 16px 48px rgba(0,0,0,.6)"
    }}>
      {/* Drag handle */}
      <div onMouseDown={startDrag} style={{
        display:"flex", alignItems:"center", gap:10,
        padding:"9px 12px", cursor:"grab", userSelect:"none",
        borderBottom: minimized ? "none" : "1px solid rgba(255,255,255,.08)",
        background:"rgba(255,255,255,.04)"
      }}>
        {chat.portrait_url
          ? <img src={chat.portrait_url} style={{ width:28, height:28, borderRadius:"50%", objectFit:"cover", flexShrink:0 }} />
          : <div style={{ width:28, height:28, borderRadius:"50%", background:"rgba(255,255,255,.15)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:"rgba(255,255,255,.7)", fontFamily:font, flexShrink:0 }}>{chat.name?.[0]||"?"}</div>
        }
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontFamily:font, fontSize:12, fontWeight:500, color:"rgba(255,255,255,.9)", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{chat.name}</div>
          {chat.subtitle && <div style={{ fontFamily:font, fontSize:10, color:"rgba(255,255,255,.4)" }}>{chat.subtitle}</div>}
        </div>
        <div style={{ display:"flex", gap:6 }}>
          <button onMouseDown={e=>e.stopPropagation()} onClick={() => setMinimized(m=>!m)}
            style={{ background:"none", border:"none", color:"rgba(255,255,255,.35)", cursor:"pointer", fontSize:14, padding:"0 3px", lineHeight:1 }}>
            {minimized ? "□" : "−"}
          </button>
          <button onMouseDown={e=>e.stopPropagation()} onClick={onClose}
            style={{ background:"none", border:"none", color:"rgba(255,255,255,.35)", cursor:"pointer", fontSize:14, padding:"0 3px", lineHeight:1 }}>✕</button>
        </div>
      </div>

      {!minimized && (
        <>
          <div style={{ display:"flex", height:280 }}>
            {/* Portrait */}
            <div style={{ width:110, flexShrink:0, position:"relative", background:"rgba(0,0,0,.3)" }}>
              {chat.portrait_url
                ? <img src={chat.portrait_url} style={{ width:"100%", height:"100%", objectFit:"cover", objectPosition:"top" }} />
                : <div style={{ width:"100%", height:"100%", display:"flex", alignItems:"center", justifyContent:"center", fontSize:32, color:"rgba(255,255,255,.15)", fontFamily:font }}>{chat.name?.[0]||"?"}</div>
              }
            </div>

            {/* Messages */}
            <div style={{ flex:1, overflowY:"auto", padding:"10px", display:"flex", flexDirection:"column", gap:6, borderLeft:"1px solid rgba(255,255,255,.06)" }}>
              {chat.loading && chat.messages.length === 0 && (
                <div style={{ display:"flex", gap:4, padding:"4px 2px" }}>
                  {[0,.15,.3].map((d,i) => <div key={i} style={{ width:5, height:5, borderRadius:"50%", background:"rgba(181,148,90,.6)", animation:`pulse .9s ${d}s infinite` }} />)}
                </div>
              )}
              {chat.messages.map((m, i) => (
                <div key={i} style={{ display:"flex", justifyContent: m.role==="user" ? "flex-end" : "flex-start" }}>
                  <div style={{ maxWidth:"88%", padding:"5px 9px", borderRadius: m.role==="user" ? "10px 10px 2px 10px" : "10px 10px 10px 2px", background: m.role==="user" ? "rgba(181,148,90,.25)" : "rgba(255,255,255,.08)", color: m.role==="user" ? "rgba(255,255,255,.9)" : "rgba(255,255,255,.75)", fontSize:11, fontFamily:font, lineHeight:1.4 }}>{m.content}</div>
                </div>
              ))}
              {chat.loading && chat.messages.length > 0 && (
                <div style={{ display:"flex", gap:4, padding:"4px 2px" }}>
                  {[0,.15,.3].map((d,i) => <div key={i} style={{ width:5, height:5, borderRadius:"50%", background:"rgba(181,148,90,.6)", animation:`pulse .9s ${d}s infinite` }} />)}
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          {!chat.ended ? (
            <div style={{ padding:"8px 10px", borderTop:"1px solid rgba(255,255,255,.06)", display:"flex", gap:6 }}>
              <input value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key==="Enter" && !e.shiftKey && input.trim()) { onSend(input.trim()); setInput(""); } }}
                placeholder={`Message ${chat.name}…`} disabled={chat.loading}
                style={{ flex:1, background:"rgba(255,255,255,.07)", border:"1px solid rgba(255,255,255,.1)", borderRadius:16, padding:"5px 10px", fontSize:11, fontFamily:font, color:"rgba(255,255,255,.85)", outline:"none" }} />
              <button onClick={() => { if(input.trim()) { onSend(input.trim()); setInput(""); } }}
                disabled={chat.loading || !input.trim()}
                style={{ background:"rgba(181,148,90,.6)", border:"none", borderRadius:16, padding:"5px 10px", fontSize:11, color:"#fff", cursor:"pointer", opacity: chat.loading || !input.trim() ? 0.4 : 1 }}>↑</button>
            </div>
          ) : (
            <div style={{ padding:"8px 10px", borderTop:"1px solid rgba(255,255,255,.06)", display:"flex", justifyContent:"center" }}>
              <button onClick={onClose} style={{ background:"rgba(255,255,255,.08)", border:"1px solid rgba(255,255,255,.1)", borderRadius:20, padding:"6px 18px", fontSize:11, fontFamily:font, color:"rgba(255,255,255,.5)", cursor:"pointer" }}>
                Walk away
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Delta bubbles ─────────────────────────────────────────────────────────────

function DeltaBubble({ delta }) {
  return (
    <div style={{ background:"rgba(0,0,0,.8)", borderRadius:20, padding:"4px 10px", fontSize:11, fontFamily:font, display:"flex", gap:8, animation:"fadeUp .3s ease", pointerEvents:"none" }}>
      {delta.warmth > 0 && <span style={{ color:"#e8a87c" }}>+warmth</span>}
      {delta.warmth < 0 && <span style={{ color:"#999" }}>-warmth</span>}
      {delta.trust > 0  && <span style={{ color:"#7cb9e8" }}>+trust</span>}
      {delta.trust < 0  && <span style={{ color:"#999" }}>-trust</span>}
      {delta.tension > 0 && <span style={{ color:"#e87c7c" }}>+tension</span>}
      {delta.tension < 0 && <span style={{ color:"#7ce87c" }}>-tension</span>}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function VenueChatBubbles({ chats, deltas, onSend, onClose, onToggle }) {
  const venueChat    = chats.find(c => c.is_venue);
  const privateChats = chats.filter(c => !c.is_venue);

  return (
    <>
      <style>{`
        @keyframes fadeUp { from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)} }
        @keyframes pulse  { 0%,100%{opacity:.3}50%{opacity:1} }
      `}</style>

      {/* Delta bubbles */}
      <div style={{ position:"fixed", bottom:80, right:24, zIndex:1300, display:"flex", flexDirection:"column", gap:6, alignItems:"flex-end", pointerEvents:"none" }}>
        {deltas.map(d => <DeltaBubble key={d.id} delta={d} />)}
      </div>

      {/* Private chat floating windows */}
      {privateChats.map((chat, i) => (
        <PrivateChatWindow
          key={chat.id}
          chat={chat}
          onSend={msg => onSend(chat.id, msg)}
          onClose={() => onClose(chat.id)}
          initialX={Math.max(20, (window.innerWidth || 800) - 420 - i * 30)}
          initialY={Math.max(20, ((window.innerHeight || 600) - 420) / 2 - i * 20)}
        />
      ))}

      {/* Venue feed — bottom right, always */}
      {venueChat && (
        <div style={{ position:"fixed", bottom:0, right:16, zIndex:1200 }}>
          <VenueFeedBubble
            chat={venueChat}
            onSend={msg => onSend(venueChat.id, msg)}
            onToggle={() => onToggle(venueChat.id)}
          />
        </div>
      )}
    </>
  );
}
