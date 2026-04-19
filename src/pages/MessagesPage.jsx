import { useState, useEffect, useRef } from "react";
import styles from "./MessagesPage.module.css";

const AVATARS = {
  "amber-soderstrom-actor": { bg: "#1a2e1a", col: "#5c9e5c" },
  "clark-bennet-actor":     { bg: "#2a2318", col: "#b5945a" },
  "7433c360-c14a-4b42-b5c0-13621d3bea38": { bg: "#2a1e2e", col: "#9e5cbe" },
};

function DocBubble({ attachment, fromMe }) {
  const ext = attachment.name.split(".").pop().toUpperCase();
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 13px",
      borderRadius: 14,
      background: fromMe ? "#1a1814" : "rgba(255,255,255,.75)",
      border: fromMe ? "none" : "1px solid rgba(255,255,255,.9)",
      borderBottomRightRadius: fromMe ? 4 : 14,
      borderBottomLeftRadius: fromMe ? 14 : 4,
      backdropFilter: fromMe ? "none" : "blur(20px)",
      minWidth: 180,
      maxWidth: 280,
    }}>
      <div style={{
        width: 36,
        height: 44,
        borderRadius: 6,
        background: fromMe ? "rgba(255,255,255,.1)" : "rgba(0,0,0,.07)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        gap: 3,
      }}>
        <span style={{
          fontFamily: "DM Sans, system-ui, sans-serif",
          fontSize: 8,
          fontWeight: 700,
          letterSpacing: ".05em",
          color: fromMe ? "rgba(255,255,255,.5)" : "#a8a5a0",
        }}>{ext}</span>
        <div style={{
          width: 18,
          height: 2,
          borderRadius: 2,
          background: fromMe ? "rgba(255,255,255,.25)" : "rgba(0,0,0,.15)",
        }} />
        <div style={{
          width: 14,
          height: 2,
          borderRadius: 2,
          background: fromMe ? "rgba(255,255,255,.15)" : "rgba(0,0,0,.1)",
        }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{
          fontFamily: "DM Sans, system-ui, sans-serif",
          fontSize: 12,
          fontWeight: 500,
          color: fromMe ? "#faf8f4" : "#1a1814",
          margin: "0 0 2px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}>{attachment.name}</p>
        <p style={{
          fontFamily: "DM Sans, system-ui, sans-serif",
          fontSize: 10,
          color: fromMe ? "rgba(255,255,255,.4)" : "#a8a5a0",
          margin: 0,
        }}>v{attachment.version ?? 1}</p>
      </div>
    </div>
  );
}

function ProposalBubble({ message, onAccept, onDecline }) {
  const payload = (() => {
    try { return message.payload ? JSON.parse(message.payload) : null; }
    catch { return null; }
  })();
  if (!payload) return <p style={{fontFamily:"DM Sans,system-ui,sans-serif",fontSize:13,lineHeight:1.55,padding:"9px 13px",borderRadius:16,background:"rgba(255,255,255,.75)",color:"#1a1814"}}>{message.content}</p>;

  const venue = payload.location_name || payload.locationname || "Venue TBD";
  const time  = payload.proposed_time || payload.proposedtime  || "Time TBD";
  const responded = !!message.responded_at;

  return (
    <div style={{
      background: "rgba(255,255,255,.75)",
      backdropFilter: "blur(20px)",
      border: "1px solid rgba(255,255,255,.9)",
      borderRadius: 16,
      borderBottomLeftRadius: 4,
      padding: "11px 13px",
      maxWidth: 300,
    }}>
      <p style={{fontFamily:"DM Sans,system-ui,sans-serif",fontSize:13,lineHeight:1.55,color:"#1a1814",marginBottom:10}}>{message.content}</p>
      <div style={{
        background: "rgba(176,92,8,.06)",
        border: "1px solid rgba(176,92,8,.15)",
        borderRadius: 10,
        padding: "9px 11px",
        marginBottom: responded ? 0 : 10,
      }}>
        <p style={{fontFamily:"DM Sans,system-ui,sans-serif",fontSize:9,letterSpacing:".12em",textTransform:"uppercase",color:"#b05c08",marginBottom:5}}>Meetup proposal</p>
        <p style={{fontFamily:"DM Sans,system-ui,sans-serif",fontSize:13,fontWeight:500,color:"#1a1814",margin:"0 0 2px"}}>📍 {venue}</p>
        <p style={{fontFamily:"DM Sans,system-ui,sans-serif",fontSize:12,color:"#6b6760",margin:0}}>🕐 {time}</p>
      </div>
      {!responded ? (
        <div style={{display:"flex",gap:7}}>
          <button onClick={() => onAccept(message, venue, time)} style={{
            flex:1,padding:"7px 0",borderRadius:9,
            background:"#1a7a35",color:"white",border:"none",
            fontFamily:"DM Sans,system-ui,sans-serif",fontSize:12,fontWeight:500,cursor:"pointer"
          }}>✓ Accept</button>
          <button onClick={() => onDecline(message, venue)} style={{
            flex:1,padding:"7px 0",borderRadius:9,
            background:"rgba(0,0,0,.06)",color:"#6b6760",
            border:"1px solid rgba(0,0,0,.1)",
            fontFamily:"DM Sans,system-ui,sans-serif",fontSize:12,fontWeight:500,cursor:"pointer"
          }}>✗ Decline</button>
        </div>
      ) : (
        <p style={{fontFamily:"DM Sans,system-ui,sans-serif",fontSize:11,color:"#a8a5a0",textAlign:"center"}}>Responded</p>
      )}
    </div>
  );
}

export default function MessagesPage() {
  const params       = new URLSearchParams(window.location.search);
  const appId        = params.get("app");
  const autoContact  = params.get("contact");

  const [me, setMe]                       = useState(null);
  const [contacts, setContacts]           = useState([]);
  const [selected, setSelected]           = useState(null);
  const [messages, setMessages]           = useState([]);
  const [draft, setDraft]                 = useState("");
  const [sending, setSending]             = useState(false);
  const [autoOpened, setAutoOpened]       = useState(false);
  const [appName, setAppName]             = useState("Messages");
  const [pendingAttachment, setPendingAttachment] = useState(null); // { id, name, version, path }
  const [uploading, setUploading]         = useState(false);
  const [dragging, setDragging]           = useState(false);
  const [context, setContext]             = useState(null); // { memories, conflicts }
  const pollRef     = useRef(null);
  const bottomRef   = useRef(null);
  const fileInputRef = useRef(null);
  const dragCounter = useRef(0);

  useEffect(() => {
    if (autoContact && contacts.length > 0 && me && !autoOpened) {
      const target = contacts.find(c => c.id === autoContact);
      if (target) {
        setAutoOpened(true);
        openConversation(target);
      }
    }
  }, [contacts, me, autoContact]);

  useEffect(() => {
    fetch("/api/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) { window.location.href = "/login"; return; }
        setMe(data);
        const world = data.worlds?.[0];
        if (world) {
          if (appId) {
            fetch("/api/apps")
              .then(r => r.ok ? r.json() : [])
              .then(apps => {
                const app = apps.find(a => a.id === appId);
                if (app) {
                  setAppName(app.name);
                  document.title = app.name;
                  loadContacts(world.world_id, world.actor_id, app.contact_ids);
                } else {
                  loadContacts(world.world_id, world.actor_id, null);
                }
              });
          } else {
            loadContacts(world.world_id, world.actor_id, null);
          }
        }
      });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function loadContacts(worldId, actorId, contactIds) {
    fetch(`/api/worlds/${worldId}/actors/${actorId}/contacts`)
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        if (contactIds && contactIds.length > 0) {
          const allowedIds = contactIds.map(c => typeof c === "object" ? c.id : c);
          setContacts(data.filter(c => allowedIds.includes(c.id)));
        } else {
          setContacts(data);
        }
      });
  }

  function openConversation(contact) {
    setSelected(contact);
    setMessages([]);
    setPendingAttachment(null);
    setContext(null);
    if (pollRef.current) clearInterval(pollRef.current);
    const world = me?.worlds?.[0];
    if (!world) return;
    loadMessages(world.world_id, world.actor_id, contact.id);
    // Load psychological context only for companion/character contacts
    if (contact.actor_type === "companion" || contact.actor_type === "character") {
      fetch(`/api/worlds/${world.world_id}/actors/${world.actor_id}/context/${contact.id}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) setContext(data); });
    }
    pollRef.current = setInterval(() => {
      loadMessages(world.world_id, world.actor_id, contact.id);
    }, 3000);
  }

  function loadMessages(worldId, actorId, contactId) {
    fetch(`/api/worlds/${worldId}/actors/${actorId}/messages/${contactId}`)
      .then(r => r.ok ? r.json() : [])
      .then(setMessages);
  }

  async function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (!file || !selected || !me) return;
    const world = me.worlds?.[0];
    if (!world) return;

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("world_id", world.world_id);
      form.append("received_from", world.actor_id);

      const res = await fetch(
        `/api/worlds/${world.world_id}/actors/${selected.id}/media`,
        { method: "POST", body: form }
      );
      if (res.ok) {
        const data = await res.json();
        setPendingAttachment(data); // { id, name, version, path }
      } else {
        alert("Upload failed.");
      }
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  function handleDragEnter(e) {
    e.preventDefault();
    dragCounter.current += 1;
    if (dragCounter.current === 1) setDragging(true);
  }

  function handleDragLeave(e) {
    e.preventDefault();
    dragCounter.current -= 1;
    if (dragCounter.current === 0) setDragging(false);
  }

  function handleDragOver(e) { e.preventDefault(); }

  async function handleDrop(e) {
    e.preventDefault();
    dragCounter.current = 0;
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) await handleFileChange({ target: { files: [file], value: "" } });
  }

  async function acceptProposal(message, venue, time) {
    const world = me?.worlds?.[0];
    if (!world || !selected) return;
    const reply = `Yes, ${venue} at ${time} works for me!`;
    await fetch(`/api/worlds/${world.world_id}/actors/${world.actor_id}/messages/${selected.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: reply, sender_name: me.name }),
    });
    await fetch(`/api/worlds/${world.world_id}/actors/${world.actor_id}/messages/${selected.id}/respond/${message.id}`, {
      method: "POST",
    });
    loadMessages(world.world_id, world.actor_id, selected.id);
  }

  async function declineProposal(message, venue) {
    const world = me?.worlds?.[0];
    if (!world || !selected) return;
    const reply = `Sorry, I can't make it to ${venue} this time.`;
    await fetch(`/api/worlds/${world.world_id}/actors/${world.actor_id}/messages/${selected.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: reply, sender_name: me.name }),
    });
    await fetch(`/api/worlds/${world.world_id}/actors/${world.actor_id}/messages/${selected.id}/respond/${message.id}`, {
      method: "POST",
    });
    loadMessages(world.world_id, world.actor_id, selected.id);
  }

  async function send() {
    const hasContent = draft.trim();
    const hasAttachment = !!pendingAttachment;
    if ((!hasContent && !hasAttachment) || sending || !selected || !me) return;

    const world = me.worlds?.[0];
    if (!world) return;
    setSending(true);
    const content = draft.trim() || `Shared a file: ${pendingAttachment.name}`;
    const attachment = pendingAttachment;
    setDraft("");
    setPendingAttachment(null);
    try {
      await fetch(`/api/worlds/${world.world_id}/actors/${world.actor_id}/messages/${selected.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          sender_name: me.name,
          ...(attachment ? { attachment } : {}),
        }),
      });
      loadMessages(world.world_id, world.actor_id, selected.id);
    } finally { setSending(false); }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function fmtTime(isoStr) {
    if (!isoStr) return "";
    return new Date(isoStr).toLocaleTimeString("sv-SE", {
      hour: "2-digit", minute: "2-digit",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
    });
  }

  function initials(name) {
    return name?.split(" ").map(n => n[0]).join("").slice(0,2).toUpperCase() || "?";
  }

  const av = selected ? (AVATARS[selected.id] || { bg: "#1e2a2e", col: "#5c9ebe" }) : null;
  const canSend = (draft.trim() || pendingAttachment) && !sending && !uploading;

  return (
    <div className={styles.shell}>

      <div className={styles.sidebar}>
        <div className={styles.sideHeader}>
          <span className={styles.appName}>{appName}</span>
          <a href="/home" className={styles.homeLink}>← Home</a>
        </div>
        <div className={styles.contactList}>
          {contacts.map(c => {
            const cav = AVATARS[c.id] || { bg: "#1e2a2e", col: "#5c9ebe" };
            return (
              <div
                key={c.id}
                className={`${styles.contactRow} ${selected?.id === c.id ? styles.contactRowSel : ""}`}
                onClick={() => openConversation(c)}
              >
                <div className={styles.contactAv} style={{background: cav.bg, color: cav.col}}>
                  {c.photo_url
                    ? <img src={c.photo_url} alt={c.name} style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:"50%"}} />
                    : initials(c.name)
                  }
                </div>
                <div className={styles.contactInfo}>
                  <p className={styles.contactName}>{c.name}</p>
                  <p className={styles.contactLast}>
                    {c.last_message
                      ? (c.last_from_me ? "You: " : "") + c.last_message.slice(0, 40)
                      : c.occupation}
                  </p>
                </div>
              </div>
            );
          })}
          {contacts.length === 0 && (
            <p className={styles.empty}>No contacts yet.</p>
          )}
        </div>
      </div>

      <div
        className={styles.main}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        style={{ position: "relative" }}
      >
        {dragging && selected && (
          <div style={{
            position: "absolute",
            inset: 0,
            zIndex: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(255,255,255,.75)",
            backdropFilter: "blur(8px)",
            border: "2px dashed rgba(0,0,0,.15)",
            borderRadius: 12,
            margin: 12,
            pointerEvents: "none",
          }}>
            <p style={{
              fontFamily: "DM Sans, system-ui, sans-serif",
              fontSize: 13,
              color: "#a8a5a0",
              letterSpacing: ".04em",
            }}>Drop to share</p>
          </div>
        )}
        {!selected ? (
          <div className={styles.noSel}>
            <p>Select a contact to start messaging</p>
          </div>
        ) : (
          <>
            <div className={styles.threadHeader}>
              <div className={styles.contactAv} style={{background: av.bg, color: av.col, width:36, height:36, fontSize:13}}>
                {selected.photo_url
                  ? <img src={selected.photo_url} alt={selected.name} style={{width:"100%",height:"100%",objectFit:"cover",borderRadius:"50%"}} />
                  : initials(selected.name)
                }
              </div>
              <div>
                <p className={styles.threadName}>{selected.name}</p>
                <p className={styles.threadRole}>{selected.occupation}</p>
              </div>
            </div>

            {/* Context strip — memories + conflicts, companions/characters only */}
            {context && (context.memories?.length > 0 || context.conflicts?.length > 0) && (
              <div style={{
                padding: "8px 1.5rem",
                background: "rgba(176,92,8,.04)",
                borderBottom: "1px solid rgba(176,92,8,.1)",
              }}>
                {context.memories?.length > 0 && (
                  <>
                    <p style={{
                      fontFamily: "DM Sans, system-ui, sans-serif",
                      fontSize: 9,
                      letterSpacing: ".12em",
                      textTransform: "uppercase",
                      color: "#b05c08",
                      marginBottom: 4,
                    }}>She remembers</p>
                    {context.memories.map(m => (
                      <div key={m.id} style={{
                        display: "flex",
                        gap: 6,
                        fontSize: 11,
                        color: "#52493e",
                        lineHeight: 1.5,
                        padding: "2px 0",
                      }}>
                        <span style={{color: m.wound_resonance ? "#c0623a" : "#b05c08", flexShrink: 0}}>•</span>
                        <span>{m.content}</span>
                      </div>
                    ))}
                  </>
                )}
                {context.conflicts?.length > 0 && (
                  <>
                    <p style={{
                      fontFamily: "DM Sans, system-ui, sans-serif",
                      fontSize: 9,
                      letterSpacing: ".12em",
                      textTransform: "uppercase",
                      color: "#c0623a",
                      marginTop: context.memories?.length > 0 ? 8 : 0,
                      marginBottom: 4,
                    }}>Tensions</p>
                    {context.conflicts.map(c => (
                      <div key={c.id} style={{
                        fontSize: 11,
                        color: "#52493e",
                        lineHeight: 1.5,
                        padding: "2px 0",
                      }}>⚡ {c.description}</div>
                    ))}
                  </>
                )}
              </div>
            )}

            <div className={styles.thread}>
              {messages.map((m) => {
                const isLastMine = m.from_me && messages.filter(x => x.from_me).slice(-1)[0]?.id === m.id;
                const receipt = isLastMine
                  ? m.read_at ? `Read ${fmtTime(m.read_at)}`
                  : m.sent_at ? "Delivered"
                  : "Sent"
                  : null;
                return (
                  <div key={m.id} className={`${styles.bubble} ${m.from_me ? styles.bubbleMe : styles.bubbleThem}`}>
                    {m.attachment
                      ? <DocBubble attachment={m.attachment} fromMe={m.from_me} />
                      : (!m.from_me && m.payload && (() => { try { const p = JSON.parse(m.payload); return p.locationname || p.location_name; } catch { return false; } })())
                        ? <ProposalBubble message={m} onAccept={acceptProposal} onDecline={declineProposal} />
                        : <p className={styles.bubbleText}>{m.content}</p>
                    }
                    <p className={styles.bubbleTime}>{fmtTime(m.sent_at)}</p>
                    {receipt && (
                      <p style={{
                        fontFamily: "var(--font-sans, system-ui)",
                        fontSize: 10,
                        color: m.read_at ? "#b5945a" : "rgba(0,0,0,.3)",
                        textAlign: "right",
                        marginTop: 2,
                        paddingRight: 4,
                      }}>{receipt}</p>
                    )}
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {/* Pending attachment strip */}
            {(pendingAttachment || uploading) && (
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 1.5rem 0",
                background: "rgba(255,255,255,.6)",
                backdropFilter: "blur(40px)",
                borderTop: "1px solid rgba(255,255,255,.8)",
              }}>
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 10px",
                  borderRadius: 8,
                  background: "rgba(0,0,0,.05)",
                  fontSize: 12,
                  fontFamily: "DM Sans, system-ui, sans-serif",
                  color: "#1a1814",
                }}>
                  {uploading
                    ? <span style={{color:"#a8a5a0"}}>Uploading…</span>
                    : <>
                        <span>📎</span>
                        <span>{pendingAttachment.name}</span>
                        <button
                          onClick={() => setPendingAttachment(null)}
                          style={{
                            marginLeft: 4,
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            color: "#a8a5a0",
                            fontSize: 14,
                            lineHeight: 1,
                            padding: "0 2px",
                          }}
                        >×</button>
                      </>
                  }
                </div>
              </div>
            )}

            <div className={styles.composer}>
              {/* Hidden file input */}
              <input
                ref={fileInputRef}
                type="file"
                style={{ display: "none" }}
                onChange={handleFileChange}
              />
              {/* Paperclip button */}
              <button
                className={styles.attachBtn}
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Attach file"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M13.5 7.5L7.5 13.5C6.1 14.9 3.9 14.9 2.5 13.5C1.1 12.1 1.1 9.9 2.5 8.5L9 2C9.9 1.1 11.4 1.1 12.3 2C13.2 2.9 13.2 4.4 12.3 5.3L6.3 11.3C5.9 11.7 5.1 11.7 4.7 11.3C4.3 10.9 4.3 10.1 4.7 9.7L10 4.5"
                    stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <textarea
                className={styles.input}
                placeholder={pendingAttachment ? "Add a message (optional)…" : `Message ${selected.name}…`}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleKey}
                rows={1}
              />
              <button className={styles.sendBtn} onClick={send} disabled={!canSend}>
                {sending ? "…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>

    </div>
  );
}
