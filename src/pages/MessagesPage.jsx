import { useState, useEffect, useRef } from "react";
import styles from "./MessagesPage.module.css";

const AVATARS = {
  "amber-soderstrom-actor": { bg: "#1a2e1a", col: "#5c9e5c" },
  "clark-bennet-actor":     { bg: "#2a2318", col: "#b5945a" },
  "7433c360-c14a-4b42-b5c0-13621d3bea38": { bg: "#2a1e2e", col: "#9e5cbe" },
};

export default function MessagesPage() {
  const params       = new URLSearchParams(window.location.search);
  const appId        = params.get("app");
  const autoContact  = params.get("contact");

  const [me, setMe]             = useState(null);
  const [contacts, setContacts] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft]       = useState("");
  const [sending, setSending]   = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);
  const [appName, setAppName]   = useState("Messages");
  const pollRef   = useRef(null);
  const bottomRef = useRef(null);

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
    if (pollRef.current) clearInterval(pollRef.current);
    const world = me?.worlds?.[0];
    if (!world) return;
    loadMessages(world.world_id, world.actor_id, contact.id);
    pollRef.current = setInterval(() => {
      loadMessages(world.world_id, world.actor_id, contact.id);
    }, 3000);
  }

  function loadMessages(worldId, actorId, contactId) {
    fetch(`/api/worlds/${worldId}/actors/${actorId}/messages/${contactId}`)
      .then(r => r.ok ? r.json() : [])
      .then(setMessages);
  }

  async function send() {
    if (!draft.trim() || sending || !selected || !me) return;
    const world = me.worlds?.[0];
    if (!world) return;
    setSending(true);
    const content = draft.trim();
    setDraft("");
    try {
      await fetch(`/api/worlds/${world.world_id}/actors/${world.actor_id}/messages/${selected.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, sender_name: me.name }),
      });
      loadMessages(world.world_id, world.actor_id, selected.id);
    } finally { setSending(false); }
  }

  function handleKey(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  }

  function initials(name) {
    return name?.split(" ").map(n => n[0]).join("").slice(0,2).toUpperCase() || "?";
  }

  const av = selected ? (AVATARS[selected.id] || { bg: "#1e2a2e", col: "#5c9ebe" }) : null;

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

      <div className={styles.main}>
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

            <div className={styles.thread}>
              {messages.map((m, i) => {
                const isLastMine = m.from_me && messages.filter(x => x.from_me).slice(-1)[0]?.id === m.id;
                const receipt = isLastMine
                  ? m.read_at ? `Read ${m.read_at.slice(11,16)}`
                  : m.sent_at ? "Delivered"
                  : "Sent"
                  : null;
                return (
                <div key={m.id} className={`${styles.bubble} ${m.from_me ? styles.bubbleMe : styles.bubbleThem}`}>
                  <p className={styles.bubbleText}>{m.content}</p>
                  <p className={styles.bubbleTime}>{m.sent_at?.slice(11,16)}</p>
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

            <div className={styles.composer}>
              <textarea
                className={styles.input}
                placeholder={`Message ${selected.name}…`}
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={handleKey}
                rows={1}
              />
              <button className={styles.sendBtn} onClick={send} disabled={!draft.trim() || sending}>
                {sending ? "…" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>

    </div>
  );
}
