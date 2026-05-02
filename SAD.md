# Anima Systems AB
# Software Architecture Document
### Version 3.8 | Last updated: 2 May 2026 | Session 59
### RUP Format — 4+1 View Model

---

## Table of Contents

1. Introduction
2. Architectural Representation
3. Architectural Goals and Constraints
4. Use Case View
5. Logical View
6. Process View
7. Physical / Deployment View
8. Data View
9. Size and Performance
10. Quality Attributes
11. Roadmap and Priorities
12. Bug History and Known Issues
13. Architectural Decisions Log
14. Critical Principles
15. Deploy Procedures
16. Session Log

---

## 1. Introduction

### 1.1 Purpose

This Software Architecture Document describes the architecture of Deliver Worlds — the AI world simulation platform developed by Anima Systems AB. It covers the four architectural views defined by the RUP 4+1 model (Logical, Process, Physical, Use Case), along with data architecture, quality attributes, and the ongoing roadmap.

### 1.2 Scope

Deliver Worlds is a persistent AI world simulation platform. It runs a continuously-operating psychological world populated by AI characters who have genuine continuity, emergent social behaviour, and grounded inner lives. The platform is described internally as *"a novel that writes itself."*

The system comprises:
- A world simulator (Elixir/Phoenix/BEAM)
- A platform API (Node.js)
- Local LLM inference (Ollama, Dolphin3)
- On-demand heavy inference (UpCloud, Hermes 3 70B)
- An administrative LiveView UI
- A player-facing encounter UI

### 1.3 Definitions and Acronyms

| Term | Definition |
|---|---|
| **World** | The persistent container — geography (places), cast (actors), running continuously. Exists independent of any observer. |
| **Scenario** | A structured event within a world. Authored starting conditions, emergent outcome. Does not spin up a separate world. |
| **Simulation** | A sandboxed run outside the live world to answer a specific question. Temporary, non-canon. |
| **Clone** | A full copy of a canonical actor, instantiated into a world, scenario, or simulation. Owns its own memories, relationships, economy, and state. |
| **Actor** | Any LLM-driven entity in the world. Retired types: `companion`, `npc`. All LLM-driven entities are `actor`. |
| **Player** | A human present in the world. Retired type: `user`. |
| **DELTAS** | JSON payload Hermes appends after each encounter response — relationship score deltas, vital deltas, scene description. |
| **Encounter** | An in-person real-time scene between the player and an actor. |
| **SGSN** | Session-state, Gating, Session management, Navigation — the engine's only concerns. Content is the LLM's concern. |
| **Arc momentum** | Relationship trajectory score that can promote ambient NPCs to full actors. |
| **Öre** | Currency sub-unit (1 SEK = 100 öre). All financial amounts stored as integer öre. |

### 1.4 References

- SAD revision history: `git log --oneline SAD.md` (35 revisions, sessions 33–55)
- Git repository: `git@github.com:iCaledonium/deliver-worlds.git`, branch `master`
- Anthropic API documentation: https://docs.anthropic.com
- ngrok public URL: https://guidebooky-elenora-alone.ngrok-free.dev

### 1.5 Founding Thesis

*"AI Janet never evolved."* The original companion system (COMPANION.SYS, Node.js) could respond but could not remember, could not want, could not grow. It was a chat interface dressed as a person.

Deliver Worlds was built to answer a different question: what if the AI character has a genuine inner life — psychology that persists, relationships that evolve, a world that continues without you? Not a chat bot. Not a game NPC. A person who exists whether or not you're watching.

The commercial thesis: the same engine that makes Frida feel real makes investor preparation, manager feedback rehearsal, and stakeholder simulation feel real. The platform is the psychology engine. Game engines, enterprise tools, and therapeutic applications are renderers on top.

**Approved taglines:**
- *"We Deliver Worlds"*
- *"What you've built is closer to a novel that writes itself."*
- *"Plans meet psychology. Sometimes psychology wins."*

---

## 2. Architectural Representation

This document uses the RUP 4+1 Architectural View Model:

| View | Describes | Primary Audience |
|---|---|---|
| **Use Case View** | Significant system scenarios | All stakeholders |
| **Logical View** | Functional decomposition, key abstractions | Developers, architects |
| **Process View** | Concurrency, process lifecycle, OTP supervision | Developers, ops |
| **Physical View** | Hardware, network, deployment topology | Ops, architects |
| **Data View** | Persistent data model, schema, sources | Developers, architects |

---

## 3. Architectural Goals and Constraints

### 3.1 Goals

- **Continuous persistence** — the world runs whether or not any player is present. Characters have schedules, make decisions, form memories, and age.
- **Psychological authenticity** — characters behave from a genuine psychological model, not a rule tree. Attachment style, wound, Big5, vitals, and relationship scores all shape every decision.
- **Emergent behaviour** — no scripted storylines. The LLM call IS the moment of consciousness. What happens next is genuinely unknown.
- **Channel bidirectionality** — encounter memories affect SMS replies. SMS history affects encounters. One continuous memory across all interaction types.
- **Cost control** — Haiku for decisions. Dolphin3 (local, free) for content. Hermes only for in-person encounters. Target: <100 API calls/hour.
- **Platform extensibility** — the API is the product. No capability exists in the UI that isn't in the API. Game engines, enterprise tools, and therapeutic apps are renderers.

### 3.2 Constraints

- **SQLite** — chosen for simplicity and zero-dependency operation on Mac Mini hardware. WAL mode for concurrent reads. Postgres migration path exists when scale requires.
- **OTP 26** — Elixir 1.16.0, Erlang 26.2.1. `NaiveDateTime` for DB timestamps — not `DateTime`. `NaiveDateTime.diff` not `DateTime.diff`.
- **16GB RAM on simulator** — Mac Mini 2012 i5 Ivy Bridge. LLM inference offloaded to dedicated M4 machine.
- **CLAUDE_API_KEY** — not `ANTHROPIC_API_KEY`. The env var name matters.
- **No gates — only weights** — hard architectural constraint. Psychology as pool modifiers, not if/else blockers. Physical impossibility is the only hard gate.
- **SGSN principle** — engine manages state, routing, and handoffs only. It never interprets content. LLM handles what was said; engine tracks who is with whom and when.

---

## 4. Use Case View

### 4.1 Significant Use Cases

**UC-01: Player knocks on actor's door**
Player navigates to actor's location and initiates knock. System evaluates whether actor is home and psychologically open to visitors. Hermes generates knock decision. On `open_door`, encounter begins. Actor remembers the visit.

**UC-02: In-person encounter**
Player and actor in real-time dialogue. Hermes generates responses. DELTAS update relationship scores, vitals, sobriety, and scene description each exchange. Memories form every ~90 seconds. Encounter persists across page reloads.

**UC-03: SMS exchange**
Player texts actor. Dolphin3 generates reply using lean prompt: identity + vitals + memories-per-source + last 8 messages + incoming message. `rs_label` read from `actor_relationships.relationship_status`. Reply reflects emotional state and relationship register.

**UC-04: Actor daily life (unobserved)**
Between player interactions, actors follow schedules, make social decisions, reach out to other actors, form memories from their conversations, and respond to events. The world continues without the player.

**UC-05: Work offer (freelancer)**
`WorkOfferGenerator` fires every world tick for eligible freelancers. Haiku generates a realistic offer. Venue is resolved: DB name match → DB category fallback → Google Places Text Search (discovers real new venue, seeds into places table, actor learns location). Actor receives offer in inbox, makes accept/reject decision via psychology.

**UC-06: Crosspath encounter**
Two actors arrive at the same location within the same tick. `EngineServer` detects crosspath, builds participant structs, fires co-presence LLM evaluation. Actors may notice each other, approach, or ignore — determined by psychology.

**UC-07: Player builds a world (platform)**
Creator logs in to platform. Creates world, seeds actors from canonical registry (cloning). Configures world parameters. Publishes. Others can be invited as players.

**UC-08: Frida with champagne**
Player arrives with champagne. Actor greets player. Each sip: Hermes returns `sobriety_delta: -0.04` in DELTAS. Sobriety drops from 1.0 over the evening. Actor's responses soften, become warmer, more physically aware. `scene_description` tracks "Frida and Magnus on the couch, champagne on the coffee table." Memory formed: intimate evening with cheese and champagne.

### 4.2 Actor Interaction Map (world-internal)

```
Magnus Klack (player)
    ↕ encounter / SMS / call / voice message
Frida Svensson — companion, actress/model (freelance)
    ↕ voice messages / texts
Julia Höglund, Emma Sjöström, Magnus Petersson, et al. (NPCs)

Clark Bennet — Head of Sales, Anima
    ↕ texts Magnus about Anima business
Amber Söderström — Head of AI Worlds, Anima / FWB
    ↕ texts, encounters

NPCs reach out to each other: Sara ↔ Emma ↔ Johan ↔ Nicole ↔ Julia ↔ Alex ↔ David ↔ Magnus P.
```

---

## 5. Logical View

### 5.1 Module Overview

```
World Simulation Layer
├── EngineServer         — tick orchestration, crosspaths, world context
├── AgentLoop            — per-actor decision loop, action pool
├── ActorServer          — actor coordinator, state machine, co-presence handler
└── ActorProcessSupervisor
    ├── SomaticProcess   — autonomic NS (energy, sobriety, hunger)
    ├── PerceptionProcess— location scanning, co-presence detection, actor↔actor broadcast
    ├── AffectProcess    — emotional state
    ├── MemoryProcess    — memory formation triggers
    ├── SocialProcess    — relationship tracking
    ├── DriveProcess     — needs, motivations, drive pool
    ├── ScheduleProcess  — schedule proposals
    ├── ObjectiveProcess — goal tracking, arc momentum
    └── VisionProcess    — spatial awareness

Encounter Layer
└── EncounterProcess     — in-person scene lifecycle, Hermes calls, DELTAS

Meeting Layer
└── MeetingRunner        — Actor↔Actor in-person conversation engine (Dolphin3)

Communication Layer
├── MessageEngine        — SMS/text reply generation (Dolphin3)
├── ThoughtEngine        — background actor thoughts (Dolphin3)
└── InteractionHandler   — message sending pipeline

Memory Layer
├── MemoryEngine         — memory formation from conversations + promise extraction
└── KnownLocations       — actor mental map of places

Work / Economy Layer
├── WorkOfferGenerator   — freelancer offer generation + venue resolution
├── WorkOfferHandler     — offer acceptance, itinerary building
├── FinancialEngine      — salary, expenses, bank accounts
└── TransitEngine        — route calculation, travel itineraries

World Building Layer
├── FeedWriter           — world feed entries
├── DecisionLog          — per-actor decision audit trail with alternatives
└── HermesManager        — UpCloud server URL management (minimal GenServer)
```

### 5.2 Human Process Tree Architecture

Each actor is modelled as a human nervous system. The OTP supervision tree mirrors this directly:

```
ActorSupervisor
└── ActorProcessSupervisor (:one_for_one)
    ├── SomaticProcess    — body: energy, sobriety, hunger, pain
    ├── PerceptionProcess — senses: location scan, co-presence
    ├── AffectProcess     — affect: mood, emotional residues
    ├── MemoryProcess     — memory: formation, decay, retrieval
    ├── SocialProcess     — social: relationship updates
    ├── DriveProcess      — drives: needs, motivations
    ├── ScheduleProcess   — schedule: proposals, not commands
    ├── ObjectiveProcess  — objectives: goals, arc momentum
    ├── VisionProcess     — vision: spatial awareness
    │                       (visual: disabled = blind actor)
    └── ActorServer       — conscious coordinator
```

`:one_for_one` means a crashing process does not kill the actor. A blind actor has `VisionProcess` with `visual: disabled`. Physical disability is configuration, not a special case.

### 5.3 LLM Profile per Actor

Each actor carries an `llm_profile` governing model selection by context:

```json
{
  "default":          "dolphin3",
  "user_facing":      "claude-haiku",
  "heavy_generation": "claude-haiku"
}
```

- **`default`** — internal world behaviour: thoughts, state transitions, sub-activity selection
- **`user_facing`** — messages sent to a human player; always a censored model
- **`heavy_generation`** — transcript backfill, long-form narrative; Haiku or above

Frida uses `dolphin3` as default — uncensored, capable of selecting `intimacy` subs and generating appropriate internal state. Encounters use Hermes 3 70B — the model quality that makes encounters feel real.

### 5.4 Core Vocabulary

**World** — the persistent container. Geography (places), cast (actors), running continuously.
**Scenario** — a structured event *within* a world. Authored setup, emergent outcome.
**Simulation** — sandboxed non-canon run to answer a specific question.
**Clone** — full copy of a canonical actor, instantiated into a world. Owns its own memories, relationships, economy, state.

Actor types:
- `actor` — all LLM-driven entities. (`companion`, `npc` are retired.)
- `player` — a human present in the world. (`user` is retired.)

### 5.5 Relationship System

Source of truth: `actor_relationships` table. **Never use `relationship_states`** (stale legacy).

```
warmth     float  — emotional warmth toward the other actor
trust      float  — degree of trust
attraction float  — physical / romantic attraction
tension    float  — active conflict / discomfort
relationship_status  enum
```

**Status values:** `strangers`, `acquaintances`, `friends`, `close_friends`, `best_friends`, `romantic_interest`, `dating`, `partners`, `friends_with_benefits`, `ex_partners`, `family`, `colleagues`, `rivals`

### 5.6 Memory Architecture

Memory sources: `encounter`, `text_thread`, `call`, `video_call`, `email_thread`, `voice_message`

**load_memories_of (message engine — SMS replies):**
Up to 3 most recent per source type via ROW_NUMBER PARTITION BY source:
```sql
SELECT content FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY inserted_at DESC) as rn
  FROM memories
  WHERE actor_id = ? AND other_actor_id = ?
    AND source IN ('encounter','text_thread','call','video_call','email_thread','voice_message')
) ranked WHERE rn <= 3 ORDER BY inserted_at DESC
```

**load_relevant_memories (memory engine — inject_for_reply):**
- Recent memories (last 6h) loaded first regardless of emotional weight
- Older memories ordered by `emotional_weight DESC`
- Encounter memory weights: actor=0.9, player=0.85

**Bidirectionality:**
- SMS → Encounter: `load_context` injects last 8 `inbox_messages` as `recent_messages` in system prompt
- Encounter → SMS: encounter memories (0.9 weight) dominate reply context

A character who received "I'll be there in 10 min with cheese and red wine" by SMS opens the door knowing what to expect. After the encounter, the same character replies to texts with the full emotional context of what happened.

### 5.7 Encounter System

```
Player knock
    → EncounterProcess:begin
        → ActorServer:{encounter_pending}     [transit blocked immediately]
        → Task: load_context                  [DB, memories, last 8 SMS]
            → build_encounter_system_prompt   [still in Task, not GenServer]
        → {:context_loaded, context, system_prompt}
    → call_hermes: knock decision             [direct HTTP, no gating]
        [open_door | decline | no_answer]
        (system: "Your response must begin with { and end with }. ONLY raw JSON.")
    → call_hermes_multi_turn: first_words
    → encounter loop:
        player_input → DELTAS_instruction appended → call_hermes_multi_turn
            ← response_text DELTAS:{...}
        → split on "DELTAS:" — text before = speech, JSON after = deltas
        → apply_deltas (relationship scores, vitals, sobriety, scene_description)
        → write_encounter_memories (every ~90s)
    → encounter end:
        → final memory write
        → ActorServer:{encounter_ended}       [transit unblocked, pending cleared]
```

**Actor↔Actor co-presence:** `PerceptionProcess` broadcasts `{:co_presence_detected_actors}` to `ActorServer` when two non-player actors are at the same location. `ActorServer` stores in `co_present_actors`, fires a tick. `actor_engine` builds `venue_approach_actor` pool entries weighted by warmth, loneliness, and extraversion. `execute_and_feel({:venue_approach_actor,...})` starts `MeetingRunner`. A duplicate meeting guard (`in_meeting?`) prevents double-starting.

**MeetingRunner v2:** Drives Actor↔Actor in-person conversations via Dolphin3 on M4. Full psychology per speaker, memories per pair, mini-DELTAS per turn. Model picks who speaks (no round-robin). Natural ending detection, 20-turn ceiling. Speaker resolved by name OR id with `rem(turn-1, n)` alternation fallback.

**Pending player messages:** `EncounterProcess` queues player messages received before the encounter reaches `:live` phase in `pending_player_message` state field, delivered on first live turn.

**DELTAS schema:**
```json
{
  "warmth_delta": 0.00, "trust_delta": 0.00,
  "attraction_delta": 0.00, "tension_delta": 0.00,
  "sobriety_delta": 0.00,
  "desire_delta": 0.00, "loneliness_delta": 0.00,
  "stress_delta": 0.00, "mood_delta": 0.00,
  "intimacy_occurred": false, "love_expressed": false,
  "commitment_language": false,
  "arc_signal": "neutral|warmth|vulnerability|intimacy|conflict|repair|commitment",
  "scene_description": "one sentence: current room, physical position of both people"
}
```

`sobriety_delta: -0.04` per alcohol drink consumed.
`scene_description` persists across turns — Hermes writes spatial state, receives it back, preventing drift over long conversations.

### 5.8 Message Engine — build_reply_prompt (lean structure)

1. Identity + occupation + `rs_label` (from `actor_relationships.relationship_status`)
2. Vitals: energy, mood, stress, desire, loneliness, sobriety
3. Memories via `load_memories_of` (ROW_NUMBER per source)
4. Conversation history via `load_conversation_history`
5. The incoming message
6. Document attachment if present
7. Two instruction lines

**Model:** Dolphin3. Lean prompt — 8B models need signal not essays.

### 5.9 Work Offer System

**Venue resolution (3-tier):**
1. DB fuzzy name match — partial match on `places.name`
2. DB category fallback — random Stockholm venue matching work category
3. Google Places Text Search — `"#{name}, #{area}"` → real `place_id` → seeded into `places` → actor learns location via `KnownLocations`

Freelancers discover real new venues through assignments.

### 5.10 State Vocabulary

State = location + activity + sub. Never compound strings. Always FK to vocabulary tables.

**Activity categories (16):** Sleep, Home, Work, Personal Care, Food & Drink, Exercise, Social, Culture, Creative, Transit, Outdoor, Personal, Spiritual, Communication, Intimacy, Admin

**Portable subs (16, location-independent):** `on_call`, `texting`, `on_phone`, `reading`, `scrolling`, `listening`, `watching_tv`, `podcast`, `sketching`, `journaling`, `note_taking`, `people_watching`, `photographing`, `flirting`, `intimacy`, `drinking_alcohol`

`intimacy` is a sub, not a main activity. Location privacy + co-presence determine eligibility.

---

## 6. Process View

### 6.1 Supervision Tree

```
Application
├── Repo                     [SQLite, WAL]
├── StateVocabulary          [ETS cache — must start after Repo]
├── PubSub
├── HermesManager            [GenServer — UpCloud lifecycle]
├── EngineServer             [GenServer — world tick]
├── WorldSupervisor
│   └── ActorSupervisor (per actor)
│       └── ActorProcessSupervisor (:one_for_one)
│           ├── SomaticProcess
│           ├── PerceptionProcess
│           ├── AffectProcess
│           ├── MemoryProcess
│           ├── SocialProcess
│           ├── DriveProcess
│           ├── ScheduleProcess
│           ├── ObjectiveProcess
│           ├── VisionProcess
│           └── ActorServer
├── EncounterSupervisor
│   └── EncounterProcess (per active encounter, :temporary)
└── Phoenix.Endpoint
    ├── InternalWorldController
    ├── InternalSSEController
    ├── DemoHandler / DemoPlug
    └── WorldSimLive (LiveView admin UI)
```

### 6.2 World Tick

`EngineServer` fires a tick every 60 seconds:
```
1. Fetch weather, world context (every tick)
2. Every 10 ticks: Task.start(WorkOfferGenerator.run)
3. Detect crosspaths (actors at same location)
4. For each crosspath: co-presence Haiku evaluation
5. Broadcast tick to all ActorServers
6. Each ActorServer fires AgentLoop independently
```

### 6.3 AgentLoop

```
ActorServer receives :tick
    → AgentLoop.run(actor_state, world_context)
        → build_action_pool
            [schedule_follow, reach_out, approach, rest, read_message, ...]
        → call_haiku (PICK action from pool)
        → execute action
            → reach_out: InteractionHandler.send/5
            → approach: EncounterProcess (if venue + player co-present)
            → follow_schedule: state transition
        → FEEL: emotional residue from action outcome
        → next_tick = duration of chosen action
```

### 6.4 HermesManager

```
Minimal GenServer — URL management only. No state machine, no gates.

hermes_url/0      → always returns "http://212.147.242.70:11434/api/chat"
ensure_running/0  → no-op (compatibility shim)
record_activity/0 → no-op
notify_unreachable/0 → logs warning only
```

**Design principle:** HermesManager does not gate Hermes calls. Every HTTP call goes directly through. If Hermes is unreachable, `Req.post` returns a transport error which the caller handles. The caller (EncounterProcess) logs the failure and broadcasts `encounter_error` to the client. No blocking, no waiters, no state machine.

**UpCloud server management** (start/stop logic) is deferred to a future clean implementation. For now, the server IP is hardcoded. The UpCloud server runs `ollama-preload.service` on boot which loads `hermes3:70b` into VRAM automatically — no warmup call needed from the simulator.

**Critical lesson from session 52:** `ensure_running()` as a blocking GenServer call was the root cause of encounter hangs. When HermesManager state was anything other than `:running`, callers blocked indefinitely. The correct pattern for HTTP calls is: call directly, handle the error at the call site. No gatekeeping.

**Hermes timeout:** `receive_timeout: 120_000` (2 minutes). First inference on `hermes3:70b` after a cold model load takes 60-90 seconds even with the model in VRAM. Subsequent calls are 5-15 seconds.

**`num_ctx` removed:** Setting `num_ctx: 8192` in Ollama options forces model context reload even when the model is already warm. This caused first-encounter delays of 60+ seconds. Removed from all Hermes calls — Ollama uses its default context window.

### 6.5 Concurrency Principles

- All DB queries from GenServer callbacks use Tasks (non-blocking)
- `load_context` and `build_encounter_system_prompt` run together in a single background Task
- `HermesManager` warmup runs in a background Task — GenServer replies immediately
- Each actor's 10 OTP processes run concurrently
- SQLite WAL allows concurrent reads while writer is active

---

## 7. Physical / Deployment View

### 7.1 Server Park

```
┌─────────────────────────────────────────────────────────────────┐
│  HOME NETWORK — 192.168.1.x                                     │
│                                                                 │
│  Mac Mini M4 (192.168.1.60)                                    │
│  ├── Ollama: dolphin3:latest (primary inference)               │
│  ├── Kingston XS2000 1TB USB-C (model storage)                 │
│  ├── macOS, 16GB unified memory                                │
│  └── Internet Sharing → ethernet → 2012                       │
│                                                                 │
│  Mac Mini 2012 i5 (192.168.1.58)  ← WORLD SIMULATOR           │
│  ├── deliver-worlds.service (Phoenix :4000)                    │
│  ├── DB: /mnt/anima-db/dev.db (SQLite WAL)                    │
│  ├── Media: ~/deliver_worlds/priv/static/media/actors/         │
│  ├── Ubuntu 24.04, Elixir 1.16.0-otp-26, Erlang 26.2.1        │
│  ├── 16GB RAM, i5 Ivy Bridge                                   │
│  ├── WiFi: BCM4331 via wl + wpa_supplicant (not NetworkManager)│
│  └── Static IP via netplan                                     │
│                                                                 │
│  Mac Mini 2014 (192.168.1.59)  ← PLATFORM SERVER              │
│  ├── platform-api.service (Node.js :4002)                      │
│  ├── Platform DB: ~/platform_dev.db                            │
│  ├── Media mirror: ~/platform/public/media/actors/             │
│  ├── ngrok → guidebooky-elenora-alone.ngrok-free.dev → :4002  │
│  ├── Ubuntu 24.04, 8GB RAM                                     │
│  └── SIMULATOR_URL = http://192.168.1.58:4000                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                      Internet│
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  CLOUD (on-demand)                                              │
│                                                                 │
│  UpCloud L40S GPU (Helsinki) — 212.147.242.70                  │
│  ├── Ollama: hermes3:70b (Q4, ~40GB VRAM)                      │
│  ├── ollama-preload.service (KV cache warmup on boot)           │
│  ├── $1.267/hr — spin up on first encounter knock              │
│  └── Auto-shutdown after 2h inactivity via HermesManager       │
│                                                                 │
│  Anthropic API                                                  │
│  └── Claude Haiku (decisions, work offers, meetup JSON)        │
│                                                                 │
│  Google APIs                                                   │
│  ├── Directions API (TransitEngine)                             │
│  └── Places Text Search (WorkOfferGenerator venue resolution)  │
└─────────────────────────────────────────────────────────────────┘
```

### 7.2 Nginx Routing (Mac Mini 2014)

```nginx
/                → /var/www/anima/index.html (Anima marketing homepage)
/worlds          → proxy :4000 (Phoenix LiveView admin)
/js/             → proxy :4000/js/
/assets/         → proxy :4000/assets/
/media/          → proxy :4000/media/
/live/           → proxy :4000/live/ (LiveView WebSocket — critical)
/demo/clark      → static HTML (DemoPlug WebSocket)
/demo/amber      → static HTML (DemoPlug WebSocket)
WebSocket upgrade enabled for /worlds and /live
```

### 7.3 Public Demo

Clark and Amber accessible at:
```
https://guidebooky-elenora-alone.ngrok-free.dev/demo/clark
https://guidebooky-elenora-alone.ngrok-free.dev/demo/amber
```

Both have full fact sheets injected. Served via `DemoHandler` / `DemoPlug`. Clark knows commercial/competitive positioning. Amber knows full engine architecture.

### 7.4 WiFi Notes — BCM4331 (Mac Mini 2012, important for reinstalls)

```bash
# Driver: bcmwl-kernel-source (wl module) — NOT b43
# NetworkManager cannot scan with wl — bypass it
wpa_passphrase "SSID" "pass" | sudo tee /etc/wpa_supplicant/wpa_supplicant.conf
sudo wpa_supplicant -B -i wlp2s0 -c /etc/wpa_supplicant/wpa_supplicant.conf
sudo dhclient wlp2s0
# Netplan handles static IP; remove conflicting ethernet routes if both up
```

### 7.5 Platform Architecture

```
Platform (Node.js, 192.168.1.59:4002)
├── Canonical actor registry (13 tables)
│   actors, actor_psychology, actor_big5, actor_disc, actor_hds,
│   actor_lifestyle, actor_economic, actor_mental_health,
│   actor_upbringing, actor_education, actor_diagnoses,
│   actor_expense_defaults, actor_shares, actor_media
├── API: GET/PUT /api/actors, POST /api/actors/:id/shares
├── Auth: TOTP — no passwords stored
├── Actor Editor UI: gallery + full profile editor
└── Share system: read / clone permissions

Platform decisions:
- No world_id on canonical tables — platform tables are world-independent
- actor_shares junction table — read and clone permissions
- Clark/Amber are actors not users — removed from users table
- Clone = new canonical actor — source_actor_id for lineage (TODO)
```

---

## 8. Data View

### 8.1 Databases

**Simulator DB:** `/mnt/anima-db/dev.db` on 192.168.1.58 (SQLite WAL, pragma journal_mode=WAL)
**Platform DB:** `~/platform_dev.db` on 192.168.1.59 (SQLite)

### 8.2 Key Table Groups

**World:** `worlds`, `world_members`, `world_modules`, `world_context`, `world_feed`

**Actors (normalised — session 40 migration):**
`actors`, `actor_state`, `actor_profiles`, `actor_relationships`, `actor_attachment`, `actor_big5`, `actor_disc`, `actor_hds`, `actor_personality`, `actor_lifestyle`, `actor_economic`, `actor_mental_health`, `actor_upbringing`, `actor_education`, `actor_diagnoses`, `actor_expense_defaults`, `actor_fixed_expenses`, `actor_objectives`, `actor_known_locations`, `actor_spots`, `actor_media`, `actor_thoughts`

**State vocabulary:** `state_activities`, `state_categories`, `state_subs`

**Scheduling:** `schedules`, `schedule_slots`, `schedule_templates`, `schedule_slot_templates`

**Social:** `conversations`, `conversation_participants`, `conversation_types`, `inbox_messages`, `active_needs`, `emotional_residues`, `current_with`

**Location:** `places`, `routes`, `environments`

**Encounters & Travel:** `encounter_sessions`, `travel_itineraries`, `planned_meetings`

**Economy:** `bank_accounts`, `financial_transactions`

**Misc:** `memories`, `conflicts`, `crisis_arcs`, `timeline_entries`, `scenario_seeds`, `ambient_npcs`, `users`, `sessions`, `schema_migrations`, `decision_log`, `decision_alternatives`, `promises`

### 8.5 Decision Log (Session 52)

Every agent loop decision is written to `decision_log` with the full alternative pool recorded in `decision_alternatives`. This provides a complete audit trail of actor psychology in action — what was considered, what was rejected, and why the winning action was chosen.

```sql
decision_log: id, actor_id, world_id, picked_action, reason, energy, hunger,
              mood, stress, sobriety, reference, inserted_at
decision_alternatives: id, decision_id, label, action_key, description,
                        weight, was_picked
```

### 8.6 Promise System (Session 52)

Actors extract time+place commitments from SMS exchanges. `MemoryEngine.extract_promise/6` calls Haiku to detect promises in message threads. Extracted promises are written to the `promises` table. `actor_engine` reads pending promises and generates `go_to_promise_pool_entries` — weighted pool entries with `obligation:` urgency that approach deadline linearly (weight 0.5 at creation → 0.9 as deadline nears).

```sql
promises: id, actor_id, world_id, place_id, place_name, promised_at,
          deadline_at, source_conversation_id, status, inserted_at
```

`status` values: `pending`, `fulfilled`, `broken`, `expired`

### 8.3 Schema Notes

**`actor_state`** — state is FK columns, not compound strings:
```sql
current_category_id   → state_categories.id
current_activity_id   → state_activities.id
current_sub_id        → state_subs.id
current_location      → Google Place ID (always)
current_ref           → TEXT
```

**`inbox_messages`** — correct column names:
`sender_actor_id`, `receiver_actor_id`, `sent_at`, `content`, `message_type`, `conversation_type`, `payload`

**`memories`** — source values in current DB:
`encounter`, `conversation`, `interaction`, `sim_tick`
*(Note: `text_thread`, `call`, `voice_message` not yet populated — pending)*

**`actor_relationships`** — live. Do not use `relationship_states` (stale legacy).

**Currency** — all financial amounts as integer öre (1 SEK = 100 öre). No float arithmetic.

### 8.4 conversation_types slugs
`text_thread`, `call`, `video_call`, `email_thread`, `voice_message`, `in_person`

---

## 9. Size and Performance

### 9.1 Current Scale

- 11 NPC actors + 1 player + 70 ambient NPCs
- 46 Stockholm locations
- World tick: 60 seconds
- API cost: ~$1+/hour when active

### 9.2 LLM Cost Model

| Model | Use | Cost |
|---|---|---|
| Claude Haiku | Decisions, work offers, meetup JSON | ~$0.50–1.00/hr active |
| Dolphin3 (local) | SMS replies, thoughts, content | Free |
| Hermes 3 70B (UpCloud) | Encounter dialogue | $1.267/hr when server running |

**Target: <100 Haiku calls/hour active.**

Cost controls: Haiku cooldowns, sleep tick floors (sleep_deep: 90min, sleep_light: 45min), DriveProcess cooldowns, crosspath player-only venue skip.

### 9.3 Performance Notes

- SQLite WAL — spinning HDD on Mac Mini 2012 is bottleneck. USB SSD migration pending.
- `StateVocabulary` ETS cache — zero-cost slug↔UUID lookups at runtime
- Admin LiveView — batched queries, 30s refresh, direct `TimeHelper.current_slot` calls (no GenServer)
- Crosspath detection skips player-only venues (eliminates spam every tick)
- Sleep tick floors reduce total tick count during quiet hours

---

## 10. Quality Attributes

### 10.1 Psychological Authenticity
Responses shaped by attachment style, wound, Big5, vitals, relationship scores, and recent memories. Lean prompt design ensures 8B model can process context without overload.

### 10.2 Resilience
`:one_for_one` supervision — process crash does not kill actor. `HermesManager` guard clauses prevent crash loops on nil state. `EncounterProcess` is `:temporary` — crashes end cleanly.

### 10.3 Continuity
Memory persists across sessions. Scene continuity via DELTAS `scene_description`. Encounter state persists across page reloads. Relationship scores evolve from accumulated DELTAS.

### 10.4 Privacy
Player's conversations logged as `visibility: private` in world feed. Other actors cannot see player's interactions.

### 10.5 Security
Platform uses TOTP auth. No passwords stored. Internal API routes protected by platform cookie auth. Simulator runs on LAN.

---

## 11. Roadmap and Priorities

### 11.1 Priority 0 — Critical Gaps (Block Further Development)

| # | Item | Status | Notes |
|---|---|---|---|
| P0-1 | Conversation memory writing | ❌ Not started | text_thread, call, voice_message sources empty. `MemoryEngine.form/3` must fire after conversation end. ROW_NUMBER query is ready — sources just need populating. Files: `message_engine.ex`, `interaction_handler.ex`, `memory_engine.ex` |
| P0-2 | Frida relationship seeding | ❌ Not started | All NPCs warmth=0.25, no last_contact_at toward Frida. Nobody reaches out. `frida-mmuzhy03.json` migration data exists. SQL update needed for each NPC relationship toward Frida. |

### 11.2 Priority 1 — High Value (Next Sessions)

| # | Item | Status | Notes |
|---|---|---|---|
| P1-1 | Location Engine | ❌ Not started | `places` table has `facilities`, `privacy`, `population`, `hours`, `rules` columns. `LocationEngine` needed to add pool entries from current location facilities. Magnus Petersson starved 12h despite gym/café proximity. |
| P1-2 | Ambient NPC promotion | ❌ Not started | Promote to full actor at `arc_momentum > 0.4`. `ambient_npcs` table exists. |
| P1-3 | Phone call + voicemail | ❌ Deferred | When actor calls and player doesn't answer: actor leaves a voice message (text content generated by Dolphin3, stored as `voice_message` conversation type). When actor calls during encounter: encounter acknowledges the interruption. `voice_message` conversation type exists in schema but `MemoryEngine` never populates memories from it. Currently a call only creates an `inbox_message` saying "X is calling" with no content left behind. |
| P1-4 | Chatterbox TTS | ❌ Pending UpCloud | Turbo model (350M), Swedish language, MPS acceleration on M4. Sentence-by-sentence streaming for voice encounters. Dependency: UpCloud L40S full setup. |
| P1-5 | UpCloud L40S full setup | ❌ Not done | hermes3:70b loaded + running. Chatterbox Turbo. DeepFace. Currently only hermes running — full setup needed. |
| P1-6 | Nevoria 70B model evaluation | 📋 Next session | Test `Steelskull/L3.3-MS-Nevoria-70b` (bartowski GGUF Q4_K_M) as replacement for hermes3:70b. Nevoria is a merge of EVA 3.3 (storytelling), Euryale v2.3 (scene descriptions), Anubis (prose), Negative_LLAMA (no positivity bias), Nemotron (base). Uncensored. No soft refusals. Highest ranked 70B on UGI leaderboard Jan 2025. Key test: does it produce valid DELTAS JSON reliably. Pull alongside hermes3:70b on UpCloud and run one encounter each. |

### 11.3 Priority 2 — Architecture Debt

| # | Item | Status | Notes |
|---|---|---|---|
| P2-1 | JSON blob migration | 🔄 Partial | `lifestyle_profile`, `economic_profile`, `psych_extended` → proper DB columns still pending. `last_engine_tick` blob is effectively retired — `VitalStrips` now reads `energy` from `sim_state` (DB column) directly, not from `last_engine_tick` JSON. SQL boosts work correctly. Remaining blobs ~1 dedicated session. |
| P2-2 | Function naming | ❌ Deferred | `call_haiku_first_words`, `call_haiku_response` → `call_hermes_*`. Misleading after full Hermes migration. |
| P2-3 | Streaming encounter responses | ❌ Pending TTS | Sentence-by-sentence stream for Chatterbox pipeline. Dependency: P1-4. |
| P2-4 | SQLite connection timeout | ❌ Monitoring | Task held connection >15s at 05:45 Apr 25. Root cause unknown. |
| P2-5 | `end_encounter` timeout | ❌ Monitoring | `GenServer.call :end_encounter` times out on session leave. EncounterProcess may be blocked. |
| P2-6 | NoResponseHandling | ❌ Deferred | Sara, Emma — social reasoning for unanswered message situations. TODO comment in code. |
| P2-7 | Clone lineage tracking | ❌ Not started | `source_actor_id` on cloned actors. |
| P2-8 | UpCloud start/stop API | ❌ Deferred | Session 52 attempt failed — wrong token (401), blocking boot call caused hangs. Needs dedicated session: correct UpCloud credentials, async start/stop, non-blocking boot, idle shutdown after 2h inactivity. |
| P2-9 | VitalStrips dual-storage fix | ✅ Fixed |
| P1-6 | Encounter context — full relationships + shared contacts | ✅ Fixed | `load_context` in `encounter_process.ex` only loads the actor→player relationship row. Missing: (1) actor's full relationship list with descriptions (siblings, close friends, etc.) regardless of recent contact; (2) shared relationships — people both actor and player know, injected with both perspectives. Amber must know about Saga, Johan, Tommy, David when encountering Magnus. Fix: load all actor relationships + cross-reference with player's relationships to find shared contacts. |
| P2-10 | Relationship description/context backfill | ❌ Not started | All `actor_relationships` rows with nil descriptions need backfilling (player→character rows are intentionally nil). Script needed: iterate all non-player pairs, call Haiku with both actor psychs, generate description + context, write to DB. Same prompt as wizard "Inspire me". |
| P2-11 | Platform actors table — missing simulator fields | ❌ Not started | `reputation_score`, `career_level`, `career_ladder`, `neighbourhood`, `work_place_id`, `home_type` not on platform `actors` table. Add columns + wire into ActorsEditorPage. | `VitalStrips` now reads `energy` from `sim_state` (DB `energy` column via `ActorServer`) directly. `last_engine_tick` JSON blob no longer involved in energy computation. SQL boosts (`UPDATE actor_state SET energy=0.85`) now take effect immediately via `reload_sim_state`. |

### 11.4 Priority 3 — Platform and Commercial

| # | Item | Status | Notes |
|---|---|---|---|
| P3-1 | DiaryEngine | ❌ Not started | First-person daily diary per actor. Ollama call at end of day. `diary_entries` table. Simulation → story layer. |
| P3-2 | Harvard enterprise demo | 🔄 Preparation | Johan Molin presenting to HBS OPM network June 2026. Manager feedback rehearsal (Johan → Clark) + investor simulation. David Norberg (Head of Innovations, NVIDIA). |
| P3-3 | World viewer external access | ❌ Pending | Second ngrok tunnel or simulator proxy route. Currently opens direct LAN URL from outside. |
| P3-4 | Postgres migration | ❌ Pending scale | SQLite fine for dev. Before Harvard / scale. Schema is migration-ready. |
| P3-5 | Teams/Slack/Zoom integration | ❌ Design only | Companion as team member. Enterprise vertical. |
| P3-6 | Game engine integration | ❌ Design only | Anima as psychology engine, game engine as renderer. API: actor state stream (SSE), action injection, event webhooks. David Norberg use case. |
| P3-7 | SMS to player via Twilio | ❌ Not started | Actor-initiated outbound SMS to player's real phone number. |
| P3-8 | VisionProcess attraction scoring | ❌ Pending DeepFace |
| P3-9 | Hard delete from world | ❌ Not started | Deliberate destructive action — wipes all simulator rows for an actor (memories, relationships, encounters, schedule, actor row). Platform actor preserved. Danger zone section in ActorsEditorPage. Requires explicit typed confirmation ("DELETE Saga"). |
| P3-10 | Redeploy / wake hibernated actor | ❌ Not started |
| P3-11 | actor_physical table | ❌ Not started | Structured physical attributes: height_cm, body_type, bust, waist, hips, ass_shape, hair_color, hair_length, eye_color, skin_tone. Platform + simulator. Wire into CharacterWizard Identity step and deploy payload. Used for attraction scoring and image generation prompts. | When redeploying an actor that already has a simulator row (status=offline), skip wizard and patch changed fields only. Platform deploy endpoint checks `actor_deployments` for existing simulator_actor_id — if found, PATCH not POST. | Evaluates actor photo, updates `attraction` float. Dependency: P1-5 UpCloud. |

---

## 12. Bug History and Known Issues

### 12.1 Known Issues (Active)

| Issue | Severity | Notes |
|---|---|---|
| Conversation memory writing not wired | High | text_thread, call, voice_message sources empty |
| Frida NPC relationships unseeded | High | warmth=0.25, no contact; nobody reaches out |
| Hermes DELTAS vitals not changing | High | Encounter vitals (desire, loneliness, mood etc) appear not to update after exchanges. Need to verify what Hermes actually sends back in DELTAS JSON — logging added (`[EncounterProcess] DELTAS:`) but needs a live encounter to confirm whether Hermes includes non-zero vital deltas or whether `apply_exchange_deltas` silently drops them. |
| `end_encounter` GenServer timeout | Medium | On player session leave |
| Phone interruption wiring | Low | Deferred from session 48 |
| NoResponseHandling loop | Low | Sara, Emma — TODO in code |

### 12.9 Energy Drain Analysis — Boost Reverts in 1-2 Minutes

**Symptom:** Frida and other actors are boosted to 0.85 energy via SQL. Within 1-2 minutes they are back at ~0.05.

**Root cause — dual energy storage:**

`VitalStrips` does not read `actor_state.energy` (the DB column) as its working value. It reads `micro_energy` from the `last_engine_tick` JSON blob stored in `actor_state.last_engine_tick`. The JSON blob is what the tick loop actually uses. The `energy` column is a persisted snapshot — written back periodically — but `micro_energy` is what the next tick reads as the starting value.

When you boost with:
```sql
UPDATE actor_state SET energy=0.85 WHERE actor_id='...'
```
...the `energy` column is updated but `last_engine_tick->>'$.micro_energy'` still contains 0.05. On the next `VitalStrips` tick (~60 seconds), it reads `micro_energy = 0.05` and continues draining from there. The column update is silently overwritten.

**Secondary factor — `@sleep_states` mismatch (fixed session 41):**
`VitalStrips` had `@sleep_states ~w(sleep_deep sleep_light)` which never matched actual activity slugs `sleeping`/`napping`. Actors never recovered energy during sleep and bottomed out permanently at ~0.05. Fixed by updating the slug list. However the fix only takes effect if `micro_energy` is also in sync.

**The correct boost command — both must be set together:**
```sql
UPDATE actor_state
SET energy = 0.85,
    last_engine_tick = json_set(
      COALESCE(last_engine_tick, '{}'),
      '$.vitals.energy', 0.85,
      '$.micro_energy', 0.85,
      '$.vitals.sleep_debt', 0.0
    )
WHERE actor_id = '<id>'
```

**Permanent fix — part of JSON blob migration (P2-1):**
`last_engine_tick` is a JSON blob that should not exist. The vitals it carries (`energy`, `mood`, `stress`, `desire`, `loneliness`, `sobriety`, `sleep_debt`, `micro_energy`) are already real columns on `actor_state`. The fix:
1. `VitalStrips` reads from and writes to `actor_state` columns directly — not `last_engine_tick`
2. `last_engine_tick` column dropped
3. SQL boosts (`UPDATE actor_state SET energy=0.85`) then work as expected with no dual-storage problem

This is a specific instance of the general JSON blob migration decision (P2-1). `last_engine_tick` should be the first blob targeted — it causes the most visible symptoms.
- **WorkOfferGenerator** — extracted from `engine_server.ex` into own module (280 lines removed)
- **`record_visit` FunctionClauseError** — `work_place_id` nil when Haiku invented venue not in DB. Fixed via Google Places Text Search as third resolution tier. Nicole Bergström + Sara Karlsson hit this overnight.
- **`load_context` table name** — queried `messages` (doesn't exist) instead of `inbox_messages`. Column names corrected: `sender_actor_id`, `receiver_actor_id`, `sent_at`.
- **DELTAS sobriety** — no guidance on when to set `sobriety_delta`. Added: -0.04 per alcohol drink.
- **Knock parse failure** — Hermes prefaced JSON with preamble. Strengthened system prompt: "Your response must begin with { and end with }."

### 12.2 Fixed — Session 52 (Apr 26 2026)

- **`num_ctx: 8192` in Hermes calls** — setting `num_ctx` forces Ollama to reload the model with a different context window even when it is already warm in VRAM. This caused first-encounter inference delays of 60+ seconds and timeout failures. Removed from all `Req.post` call bodies. Ollama now uses its default context window.
- **HermesManager blocking encounters** — `ensure_running()` was a blocking `GenServer.call` with a 4-minute timeout. When HermesManager state was `:starting`, `:failed`, or `:stopping`, callers blocked indefinitely. Root cause of all encounter hangs when UpCloud server was warm. Fixed by replacing entire HermesManager with a minimal GenServer that just stores the URL — `ensure_running` is now a no-op, `hermes_url` always returns immediately. No state machine, no gates, no waiters.
- **`recent_rels` blocking `load_context` Task** — added a batch DB query for recent actor relationships inside `build_encounter_system_prompt`, which ran in a synchronous Task. SQLite write contention from concurrent actor ticks caused the query to block indefinitely, preventing `{:context_loaded}` from ever firing. Feature removed; will be reimplemented correctly as an async background load.
- **`receive_timeout: 600_000`** — 10-minute timeout on Hermes calls meant encounters appeared to hang silently for up to 10 minutes before failing. Reduced to `120_000` (2 minutes) — enough for first inference on a warm 70B model.
- **MeetingRunner v2** — full rewrite with Dolphin3, psychology-per-speaker, natural ending, 20-turn ceiling, speaker resolution by name or id.
- **Actor↔Actor co-presence** — `PerceptionProcess` → `ActorServer` → `actor_engine` pipeline for venue_approach_actor pool entries + MeetingRunner start.
- **Decision Log** — `decision_log` + `decision_alternatives` tables. Full audit trail of every agent loop decision with alternatives considered.
- **Promise System** — `promises` table + `extract_promise` in MemoryEngine + `go_to_promise_pool_entries` in actor_engine. Actors honour commitments made in SMS.
- **`pending_player_message`** field on EncounterProcess — player messages received before `:live` phase are queued and delivered on first live turn.

**NOT fixed in session 52:**
- **UpCloud API integration** — attempted and failed. The `check_server_running` call used a wrong/hardcoded API token causing a 401 on boot. More critically, any API call on `init/1` blocks the supervisor tree startup and can cause encounter hangs. UpCloud start/stop logic must be implemented in a dedicated session with correct credentials, proper async design, and no blocking calls during boot. Until then HermesManager stores only the IP and the UpCloud server is started/stopped manually.

### 12.3 Fixed — Session 51 (Apr 25-26 2026)
- **Energy drain — `last_engine_tick` JSON blob** — identified as root cause. `VitalStrips` reads `micro_energy` from `last_engine_tick` JSON, not `actor_state.energy` column. The correct boost command updates both. Permanent fix deferred to JSON blob migration (P2-1).
- **`actor_big5`, `actor_mental_health` table migrations** — psychology tables added to simulator DB, mirroring platform schema.
- **Hermes multi-turn encounter** — `call_haiku_response` wired to call Hermes 70B directly instead of Haiku. Full encounter now runs on Hermes end-to-end.
- **HermesManager nil crash** — `DateTime.diff` with nil `start_requested_at`. Guard clauses added.
- **HermesManager blocking warmup** — moved warmup HTTP call into background Task.
- **`pool: :none` removed** — Req 0.5.17 doesn't support this option.
- **Encounter memory weights** — raised from 0.3→0.9 (actor), 0.2→0.85 (player).
- **`rs_label` wrong table** — reading `relationship_states.rel_state` instead of `actor_relationships.relationship_status`.
- **build_reply_prompt** — 500-token prompt overwhelmed Dolphin3. Rewritten lean.
- **load_memories_of** — ROW_NUMBER PARTITION BY source. Up to 3 per source type.
- **load_relevant_memories** — recency bias. Recent (last 6h) first.

### 12.4 Fixed — Session 47 (Apr 23-24 2026)
- Relationship status system wired to encounter + SMS prompts
- Encounter session persistence across reconnects
- Co-presence self-detection bug fixed
- Scene.jsx polling extended to 5 minutes

### 12.5 Fixed — Session 43 (Apr 22 2026)
- VenueScene hang-around UI
- Google Places photo caching
- PerceptionProcess arrival detection
- Spawn fix — Google Place ID in `current_location`

### 12.6 Fixed — Session 40 (Apr 20 2026)
- Psychology table migration — 13 normalised tables replacing JSON blobs
- JSON blob retirement across 8 files
- NoResponseHandling voice_message fix (Frida 96 unanswered overnight)
- SSE duplicate notifications (activeStreams Map fix)
- World feed privacy — player conversations marked `visibility: private`
- WORLD_ID hardcoded in platform removed
- Float.round SQLite integer bug (`anxiety * 1.0` cast)
- MeetingRunner player guard
- Document message type with iterative chunk reading

### 12.7 Fixed — Session 39 (Apr 19 2026)
- State model migration — compound strings eliminated; FK columns to vocabulary tables
- `schedule_template` JSON → `schedule_slots` rows (3088 slots, 11 actors)
- `NaiveDateTime.diff` crash fixed throughout codebase
- `StateVocabulary` startup order enforced (after Repo)
- Platform context 404 route added

### 12.8 Fixed — Sessions 33–38
- AWS EC2 fully terminated — no idle cloud charges
- Ollama on M4 live, dolphin3 wired, mannix/llama3.1-8b confabulation resolved
- Message truncation removed — `String.slice(0, 300)` removed from `clean_response/2`
- Scroll-to-bottom fixed in SMS and world phone modal
- Clark + Amber seeded as demo actors with fact sheets
- Financial system, vehicles, reputation engine deployed
- TOTP auth — no passwords stored
- ngrok persistent service

---

## 13. Architectural Decisions Log

| Decision | Rationale | Session |
|---|---|---|
| No gates — only weights | Psychology as pool modifiers, not if/else blockers | 33 |
| Human process tree | Each concern = one BEAM process. LLM call IS consciousness. | 34 |
| :one_for_one supervision | Disability is configuration, not special case | 34 |
| ScheduleProcess fires proposals not commands | Psychology wins when strong enough | 35 |
| Home = Google Place ID | `current_location` always real Place ID | 36 |
| State = FK columns not compound strings | Queryable, relational, vocabulary-driven | 39 |
| StateVocabulary ETS cache | Zero-cost slug lookups; must start after Repo | 39 |
| Subs are location-independent | Only portable parallel actions; location gates via places.facilities | 39 |
| Intimacy is a sub not a main | Location privacy + presence = eligibility | 39 |
| Canonical actor model | Actors are platform entities; worlds contain clones | 40 |
| Clone = instantiation primitive | Never borrow an actor; memories belong to clone | 40 |
| Every clone has a payer | World/scenario/simulation owner pays for compute | 40 |
| Actor type: `actor` (not companion/npc) | Unified LLM-driven entity taxonomy | 40 |
| No passwords — TOTP auth | Security without complexity | 40 |
| Psychology tables not JSON blobs | Queryability, concurrent update safety, change history | 40 |
| Currency in subunits (öre) | Integer math only — no float rounding on transactions | 34 |
| Hermes for encounters, Dolphin3 for SMS | 70B quality for in-person scenes; lean prompts for 8B | 47 |
| Scene continuity via DELTAS scene_description | Hermes writes spatial state, receives it back next turn | 49 |
| Bidirectional memory (encounter ↔ SMS) | One continuous memory across all interaction types | 49 |
| ROW_NUMBER PARTITION BY source | Correct SQL for per-channel memory | 49 |
| `actor_relationships` is source of truth | `relationship_states` is stale legacy | 49 |
| SGSN principle | Engine manages state/routing/handoffs only | 40 |
| WorkOfferGenerator discovers real venues | Google Places resolves invented names → real places | 50 |
| Lean prompts for 8B models | Signal drowns in 500-token essays | 49 |
| HermesManager never blocks in callbacks | All HTTP in Tasks; GenServer replies immediately | 49 |
| Platform is bouncer, simulator is venue | All external trust stops at platform | 36 |
| The API is the product | No capability in UI that isn't in the API | 36 |
| Streaming deferred to voice session | Sentence-by-sentence needed for Chatterbox pipeline | 49 |
| Actor↔Actor co-presence via PerceptionProcess | PerceptionProcess broadcasts to ActorServer; no EngineServer crosspath needed | 52 |
| MeetingRunner drives Actor↔Actor conversations | Dolphin3 on M4; psychology-per-speaker; natural ending; no round-robin | 52 |
| Decision log as audit trail | Every agent loop decision written with full alternative pool | 52 |
| Promise extraction from SMS | Haiku extracts time+place commitments; actor_engine generates obligation pool entries | 52 |
| HermesManager is URL storage only | No state machine, no gates, no waiters — callers handle HTTP errors directly | 52 |
| `num_ctx` removed from Hermes calls | Setting num_ctx forces model reload even when warm; removed to avoid first-inference delays | 52 |
| No gates on HTTP calls — handle errors at call site | OTP principle: let it crash, log it, handle the error where it occurs | 52 |
| UpCloud API integration deferred | Session 52 attempt failed — wrong auth token, blocking API calls on boot caused encounter hangs. UpCloud start/stop to be implemented cleanly in a dedicated session with proper credentials and no blocking calls. | 52 |

---

## 14. Critical Principles

- **Mac Mini runs UTC; actors are Stockholm** — always convert for midnight computations
- **No gates — only weights** — psychology as modifiers, never blockers
- **OTP 26** — `NaiveDateTime` for DB timestamps; `NaiveDateTime.diff` not `DateTime.diff`
- **Always pull fresh files from server before editing** — stale deploys cause significant rework
- **The LLM is the voice, not the brain** — engine decides when; LLM decides what
- **current_location is always a Google Place ID**
- **`CLAUDE_API_KEY`** — not `ANTHROPIC_API_KEY`
- **Never truncate message content**
- **Dolphin3 is the primary local model** — mannix/llama3.1-8b confabulates
- **Target: <100 LLM calls/hour active**
- **SGSN principle** — engine manages state/routing/handoffs; LLM handles content
- **Read the symptom directly** — don't abstract around errors
- **No unrequested complexity**
- **Platform is the bouncer, simulator is the venue**
- **The API is the product**
- **Schedule is a plan, not a law** — psychology wins when strong enough
- **State = location + activity + sub** — never compound strings; FK to vocabulary
- **`actor_relationships` is live** — never use `relationship_states`
- **`actor_relationships` is multi-row** — one row per dimension per directed pair. Amber→Magnus has `direct_report` (professional) + `friends_with_benefits` (social). Unique index on `(world_id, actor_id, target_actor_id, dimension_id)`
- **`platform-api.service`** — service name on 192.168.1.59:4002
- **DB is on 192.168.1.58** — path `/mnt/anima-db/dev.db`
- **`relationship_dimensions`** — professional, social, intimate, legal, family
- **`relationship_types`** — 43 types, each FK to a dimension. `friends_with_benefits` is dim-social (not intimate)

**Relationship schema detail (session 55):**

`actor_relationships` is a directed, multi-row, multi-dimension table. Each row represents one actor's experience of one dimension of a relationship with another actor.

```
actor_relationships
  actor_id          FK -> actors       -- who holds this perspective
  target_actor_id   FK -> actors       -- about whom
  dimension_id      FK -> relationship_dimensions
  rel_type_id       FK -> relationship_types
  rel_type          TEXT               -- legacy, kept for compatibility
  description       TEXT               -- structural facts (e.g. "Magnus is my employer")
  context           TEXT               -- emotional/psychological truth in first person
  started_at        TEXT               -- when this relationship dimension began
  ended_at          TEXT               -- NULL if ongoing, set when ended
  trust/warmth/respect/tension/envy/pull/guilt/attraction/arc_momentum  FLOAT
  relationship_status TEXT             -- legacy progression field
```

**Dimensions:**
- `dim-professional` — colleague, peer, direct_report, manager, founder_employee, agent, mentor, advisor, client, etc.
- `dim-social` — acquaintance, friend, close_friend, best_friend, gym_buddy, friends_with_benefits
- `dim-intimate` — entanglement, lover, exclusive, partner
- `dim-legal` — spouse, ex_spouse, ex_wife, ex_husband, engaged, domestic_partner
- `dim-family` — parent, child, sibling (future use)

**Multi-row example (Amber → Magnus):**
- Row 1: `direct_report / dim-professional` — "Magnus is my founder and employer. I report directly to him."
- Row 2: `friends_with_benefits / dim-social` — "I chose this knowing the professional complexity. Eyes open."

**Context and description fields:**
- `description` — structural facts about the relationship. What you'd tell someone objectively.
- `context` — the actor's internal psychological truth. Written in first person. Fed directly into encounter system prompt. No hardcoded strings — prompt uses context field first, description second, minimal rel_type fallback last.

**Marital status** — computed dynamically from legal dimension rows:
1. Active legal row (`ended_at IS NULL`) → show that status (married, engaged, etc.)
2. Ended legal rows, no active → `divorced`
3. No legal rows → `single`

**Relationship progression suggestion (not yet implemented):**

The `relationship_status` field currently holds a blunt progression label. The proper progression should be driven by the numeric scores + arc_momentum + explicit events:

*Social dimension progression:*
`acquaintance → casual_friend → friend → close_friend → best_friend`
Triggered by: warmth + trust crossing thresholds over time + shared memories accumulating

*Social→Intimate crossing:*
`friend → friends_with_benefits → lover → exclusive → partner`
Triggered by: attraction > 0.7 + warmth > 0.8 + arc_momentum > 0.6 + a deliberate encounter decision

*Professional progression:*
`colleague → peer → trusted_advisor / mentor / manager`
Triggered by: respect > 0.8 + trust > 0.75 + time + explicit work events

*Legal progression:*
`partner → engaged → spouse`
Triggered by: explicit world event only (not automatic). Engine records started_at.

*Regression (any dimension):*
Any relationship can decay — arc_momentum below threshold triggers status review. Ended relationships get ended_at set, not deleted. History is preserved.

**Recommended implementation approach:**
A `RelationshipProgressionWorker` runs nightly. For each directed relationship row, it evaluates current scores against progression thresholds and fires a `relationship_transition` world event if a threshold is crossed. The transition is not automatic — it generates a pool entry for the actor to act on (e.g. "Frida considers whether Magnus has become her partner in more than just practice"). Psychology wins, always.
- **`ambient_location`** — was `ambient_npcs`. Pure extension table: location_id, presence_schedule, generated_psychology, arc_momentum_threshold. Name, age, occupation live on `actors` table
- **`actor_type = ambient`** — ambient actors exist in `actors` table, NOT booted by WorldServer or ScheduleRoller, NOT ticked by engine. Visible in PerceptionProcess scans via `ambient_location` JOIN
- **`viewer_actor_id`** — set from signed JWT in URL `?viewer=` param. Controls all privacy decisions in the simulator UI

**Privacy rules (simulator UI):**
- **Character ↔ Character** — all interactions (messages, memories, meetings, transcripts) visible to all viewers
- **User ↔ Character messages** — visible only to that user (redacted to `— private message —` for others)
- **User ↔ Character encounter memories** — visible only to that user in the relationship tab
- **User ↔ Character conversation memories** — visible only to that user in the relationship tab  
- **User ↔ Character in-person meetings** — date only shown to other viewers, full transcript only to that user
- **Encounter memories** — never shown to any viewer who did not participate. Always injected into encounter system prompt regardless
- **No hardcoded actor IDs** — all privacy decisions derived from `actor_type == "user"` query + `viewer_actor_id` from session token
- **Encounter prompt injection order** — bio → financial_note → lifestyle → sexual_orientation → blind_spot/defense/paradox/coping → DISC (if dominant ≥75) → Big5 → objectives (public/shared_with_team only) → memories (30 days) → last encounter timestamp → recent messages → meetings (full week, urgency flags) → recent relationships (30 days) → relationship context (from `context` field, fallback `description`, fallback rel_type label) → attachment formula → location block
- **Simulator** — 192.168.1.58:4000
- **Platform** — 192.168.1.59:4002
- **Ollama (M4)** — 192.168.1.60:11434
- **Hermes (UpCloud)** — 212.147.242.70:11434
- **No gates on HTTP calls** — call directly, handle errors at the call site. Never gate with a state machine.
- **`num_ctx` never in Hermes calls** — forces model reload even when warm. Omit it entirely.
- **HermesManager is URL storage** — not a lifecycle manager. Start/stop UpCloud manually or via separate tooling.
- **No `ensure_running()` calls** — it is a no-op. Remove from all callers.
- **`actor_deployments` is the source of truth** for which platform actors are active in which worlds. `simulator_actor_id` may differ from `platform_actor_id` in future (clones, respawns).
- **In Play memory privacy**: owner = all memories (no `viewer_actor_id` to simulator); shared user = `viewer_actor_id` passed → simulator returns their involvement + character↔character only. Never pass `viewer_actor_id` for owner even if `world_memberships` row exists.

---

## 15.5 Deploy Wizard — Resume Instructions

The deploy wizard modal (`DeployWizardModal.jsx`) is built but the backend deploy logic is a 501 stub. Next session resumes here.

### What is complete
- All 5 wizard steps render correctly
- World selector reads from `actor_deployments` distinct worlds (platform DB)
- Character dropdown in Relationships reads from `GET /api/worlds/:id/actors` (platform DB join)
- Schedule step generates a mock schedule based on occupation; AI generation endpoint stub exists
- Media step shows portrait slots (from existing `actor_media`) + state image/animation slots derived from schedule
- Review step summarises all choices
- `POST /api/actors/:id/deploy` stub returns 501

### What needs to be built (next session)

**1. Simulator deploy endpoint** — `POST /internal/actors/deploy`

Receives full actor payload and creates all required rows:
- `actors` — identity, first_name, last_name, occupation, age, gender, appearance, home_address, home_place_id, home_lat, home_lng, neighbourhood, actor_type=character, world_id
- `actor_profiles` — psychology (orientation, attachment_style, view_on_sex, marital_status etc.)
- `actor_personality` — blind_spot, defense_mechanism, paradox, coping_strategies, sexual_orientation
- `actor_big5`, `actor_disc`, `actor_hds` — from platform assessment results
- `actor_lifestyle`, `actor_economic` — from platform tables
- `actor_upbringing` — if available
- `bank_accounts` — seed with reasonable starting balance
- `actor_state` — initial vitals (energy=0.8, mood=0.5, stress=0.2), location=home_place_id
- `actor_relationships` — seeded from wizard relationship choices with labels mapped to dimension_id + rel_type_id
- `schedules` + `schedule_templates` + `schedule_slots` — duplicate from generated template, week N → week 52
- `actor_media` — copy photo URLs from platform (same CDN path or re-upload)

Returns `{ simulator_actor_id: "..." }`.

**2. Platform deploy handler** — `POST /api/actors/:id/deploy`

- Reads full actor profile from platform DB (actors, actor_psychology, actor_big5, actor_disc, actor_hds, actor_lifestyle, actor_economic, actor_upbringing, actor_media)
- Sends to simulator `POST /internal/actors/deploy`
- On success: writes `actor_deployments` row with returned `simulator_actor_id`
- Returns `{ platform_actor_id, world_id, simulator_actor_id, world_name }`

**3. Relationship type mapping**

`GET /api/relationship-types` should return the simulator's `relationship_dimensions` + `relationship_types` tables so the wizard chips reflect the real world's taxonomy. Currently falls back to hardcoded defaults.

**4. Schedule AI generation**

`POST /api/generate/schedule` should call Haiku with actor profile and return structured schedule blocks. Currently mocked client-side.

**5. Media transfer**

After deploy, media files need to be available on the simulator. Two options:
- Platform serves media via ngrok URL (simulator fetches on demand) — simplest
- Platform copies files to simulator via SCP during deploy — more robust

### Key IDs for Saga's deploy
- Platform actor ID: `58cab1ca-c3f4-4848-a746-c718046adf4e`
- Target world: `e7368020-fc19-4914-95ac-2f7c5508a13c` (Anima — Stockholm)
- Amber's simulator ID: `amber-soderstrom-actor` (sister relationship to seed)
- Media folder: `saga-soderstrom-58cab1ca`

---

## 15. Deploy Procedures

### Standard Deploy
```bash
# Simulator file
scp ~/Downloads/file.ex magnus@192.168.1.58:~/deliver_worlds/lib/deliver_worlds/file.ex
ssh magnus@192.168.1.58 "cd ~/deliver_worlds && mix compile 2>&1 | grep error && sudo systemctl restart deliver-worlds"

# Platform file
scp ~/Downloads/file.js magnus@192.168.1.59:~/platform/src/file.js
ssh magnus@192.168.1.59 "cd ~/platform && npm run build && sudo systemctl restart platform-api"
```

### Schema Change
```bash
ssh magnus@192.168.1.58 "cd ~/deliver_worlds && sudo systemctl stop deliver-worlds && mix ecto.migrate && sudo systemctl start deliver-worlds"
```

### Git
```bash
ssh magnus@192.168.1.58 "cd ~/deliver_worlds && git add -A && git commit -m 'Session N: description' && git push origin master"

# SAD revision history
ssh magnus@192.168.1.58 "cd ~/deliver_worlds && git log --oneline SAD.md"
```

### Useful DB Commands
```bash
# Boost actor vitals (wait 10s after restart)
# CRITICAL: must update BOTH energy column AND micro_energy in last_engine_tick JSON
# or the boost will be overwritten on the next VitalStrips tick (within 1-2 minutes)
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"UPDATE actor_state SET energy=0.85, mood=0.85, stress=0.0, last_engine_tick=json_set(COALESCE(last_engine_tick,'{}'),'$.vitals.energy',0.85,'$.micro_energy',0.85,'$.vitals.sleep_debt',0.0) WHERE actor_id='<id>';\""

# Set actor activity to relaxing
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"UPDATE actor_state SET current_activity_id=(SELECT id FROM state_activities WHERE slug='relaxing' LIMIT 1) WHERE actor_id='<id>';\""

# Fix legacy :home strings
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"UPDATE actor_state SET current_location = (SELECT home_place_id FROM actors a WHERE a.id = actor_state.actor_id AND a.home_place_id IS NOT NULL) WHERE current_location LIKE '%:home';\""

# Clear stuck on_call
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"UPDATE actor_state SET current_sub_state = NULL, current_conversation_id = NULL WHERE current_sub_state IN ('on_call','on_video_call');\""

# Check Hermes state
ssh magnus@192.168.1.58 "journalctl -u deliver-worlds.service | grep 'HermesManager' | tail -15"

# Check errors
ssh magnus@192.168.1.58 "journalctl -u deliver-worlds.service | grep '\[error\]' | tail -20"

# Full memory query (no truncation)
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"SELECT inserted_at, content FROM memories WHERE actor_id='<id>' AND other_actor_id='<id>' AND source='encounter' ORDER BY inserted_at DESC;\""

# Delete specific memories by timestamp
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"DELETE FROM memories WHERE actor_id='<id>' AND source='encounter' AND inserted_at >= '<timestamp>';\""

# Erase inbox messages between two actors
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"DELETE FROM inbox_messages WHERE (sender_actor_id='<id1>' AND receiver_actor_id='<id2>') OR (sender_actor_id='<id2>' AND receiver_actor_id='<id1>');\""

# Check relationship status
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"SELECT relationship_status, warmth, trust, attraction, tension FROM actor_relationships WHERE actor_id='<id>' AND target_actor_id='<id>';\""

# Latest decisions per actor
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"SELECT a.name, d.inserted_at, d.picked_action, d.reason, d.energy, d.hunger FROM decision_log d JOIN actors a ON a.id = d.actor_id ORDER BY d.inserted_at DESC LIMIT 20;\""

# Decision alternatives (what was considered)
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"SELECT da.label, da.action_key, da.description, da.was_picked FROM decision_alternatives da JOIN decision_log d ON d.id = da.decision_id JOIN actors a ON a.id = d.actor_id WHERE a.name = 'Frida' ORDER BY d.inserted_at DESC LIMIT 30;\""

# Active promises
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"SELECT actor_id, place_name, deadline_at, status FROM promises WHERE status='pending';\""

# 3 most recent memories per source type
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"SELECT source, inserted_at, content FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY source ORDER BY inserted_at DESC) as rn FROM memories WHERE actor_id='<id>' AND other_actor_id='<id>' AND source IN ('encounter','text_thread','call','video_call','email_thread','voice_message')) ranked WHERE rn <= 3 ORDER BY inserted_at DESC;\""

# Check API call rate
ssh magnus@192.168.1.58 "journalctl -u deliver-worlds.service --since '1 hour ago' | grep -c 'claude-haiku'"
```

### Full Actor Wipe — Simulator (replace <actor_id> and <home_place_id>)
```bash
ssh magnus@192.168.1.58 "sqlite3 /mnt/anima-db/dev.db \"
DELETE FROM schedule_slots         WHERE schedule_id IN (SELECT id FROM schedules WHERE actor_id = '<actor_id>');
DELETE FROM schedules              WHERE actor_id = '<actor_id>';
DELETE FROM actor_relationships    WHERE actor_id = '<actor_id>' OR target_actor_id = '<actor_id>';
DELETE FROM actor_media            WHERE actor_id = '<actor_id>';
DELETE FROM actor_attachment       WHERE actor_id = '<actor_id>';
DELETE FROM actor_personality      WHERE actor_id = '<actor_id>';
DELETE FROM actor_big5             WHERE actor_id = '<actor_id>';
DELETE FROM actor_disc             WHERE actor_id = '<actor_id>';
DELETE FROM actor_hds              WHERE actor_id = '<actor_id>';
DELETE FROM actor_economic         WHERE actor_id = '<actor_id>';
DELETE FROM actor_lifestyle        WHERE actor_id = '<actor_id>';
DELETE FROM actor_mental_health    WHERE actor_id = '<actor_id>';
DELETE FROM actor_education        WHERE actor_id = '<actor_id>';
DELETE FROM actor_upbringing       WHERE actor_id = '<actor_id>';
DELETE FROM actor_diagnoses        WHERE actor_id = '<actor_id>';
DELETE FROM actor_state            WHERE actor_id = '<actor_id>';
DELETE FROM actor_thoughts         WHERE actor_id = '<actor_id>';
DELETE FROM actor_objectives       WHERE actor_id = '<actor_id>';
DELETE FROM actor_profiles         WHERE actor_id = '<actor_id>';
DELETE FROM actor_spots            WHERE actor_id = '<actor_id>';
DELETE FROM actor_known_locations  WHERE actor_id = '<actor_id>';
DELETE FROM actor_expense_defaults WHERE actor_id = '<actor_id>';
DELETE FROM actor_fixed_expenses   WHERE actor_id = '<actor_id>';
DELETE FROM active_needs           WHERE actor_id = '<actor_id>';
DELETE FROM memories               WHERE actor_id = '<actor_id>' OR other_actor_id = '<actor_id>';
DELETE FROM inbox_messages         WHERE sender_actor_id = '<actor_id>' OR receiver_actor_id = '<actor_id>';
DELETE FROM conversation_participants WHERE actor_id = '<actor_id>';
DELETE FROM encounter_sessions     WHERE player_actor_id = '<actor_id>' OR target_actor_id = '<actor_id>';
DELETE FROM planned_meetings       WHERE actor_a_id = '<actor_id>' OR actor_b_id = '<actor_id>';
DELETE FROM conflicts              WHERE actor_a_id = '<actor_id>' OR actor_b_id = '<actor_id>';
DELETE FROM promises               WHERE actor_id = '<actor_id>' OR promised_to_actor_id = '<actor_id>';
DELETE FROM current_with           WHERE actor_id = '<actor_id>';
DELETE FROM emotional_residues     WHERE actor_id = '<actor_id>';
DELETE FROM timeline_entries       WHERE actor_id = '<actor_id>';
DELETE FROM decision_log           WHERE actor_id = '<actor_id>';
DELETE FROM bank_accounts          WHERE actor_id = '<actor_id>';
DELETE FROM financial_transactions WHERE actor_id = '<actor_id>';
DELETE FROM places                 WHERE world_id = '<world_id>' AND place_id = '<home_place_id>';
DELETE FROM actors                 WHERE id = '<actor_id>';
\""

# Delete media folder from simulator disk
ssh magnus@192.168.1.58 "rm -rf ~/deliver_worlds/priv/static/media/actors/<media_folder>"

# Clear platform deployment record
ssh magnus@192.168.1.59 "sqlite3 ~/platform_dev.db \"DELETE FROM actor_deployments WHERE simulator_actor_id='<actor_id>';\"" 
```

---

## 16. Session Log

### Session 59 — 2 May 2026

**Deploy pipeline hardened:**
- Deploy payload is fully atomic — Ecto transaction wraps all DB writes (actor, state, psych, custom rel types, relationships both directions, schedule, media)
- Dolphin (reverse relationship generation) runs OUTSIDE transaction to avoid DB busy errors — updates rows after commit
- Compensating delete if Dolphin fails — actor wiped, platform gets clean 500
- Deploy lock via ETS `:ollama_slots {:deploy_lock, true}` — blocks all ThoughtEngine Ollama calls during deploy, `try/after` guarantees release
- Platform `simFetch` timeout raised to 3 minutes
- Simulator Repo timeout raised to 180s
- `actor_type` fixed to `"character"` on deploy
- `media_folder` auto-generated on platform actor creation
- Name trimming fixed (no more double spaces)
- `profile_photo` media_type correctly set for profile images
- User relationships: player→character row inserted with nil description (earned through play), Dolphin skipped for users
- Custom relationship types upserted to simulator `relationship_types` table on deploy
- World running assertion at start of deploy — returns 503 if world stopped
- Deploy payload saved to `~/platform/deploy-logs/{actor_id}-{timestamp}.json` (full base64 data)

**Encounter context enriched (P1-6):**
- `load_context` in `encounter_process.ex` now fetches actor's full relationship world (all rows excluding player)
- Shared contacts injected — people both actor and player know, with both perspectives
- Memory load increased to 8 most recent across all sources (was 3-per-source)
- Both sections injected into `build_encounter_system_prompt`
- `Float.round` integer crash fixed in recent_rels, actor_all_rels, shared_contacts sections

**Relationship engine:**
- `RelationshipEngine.recompute_one/3` fixed — `Repo.get_by` → `Repo.all` + pick highest warmth row, handles multiple dimensions per pair

**Gallery:**
- Deployed actors show `↓` undeploy button (circle, top right) instead of ✕
- Undeployed actors show ✕ delete + Deploy →
- `DELETE /api/actors/:id` endpoint added with full cascade delete
- `undeployed_at` + `deploy_status` columns added to `actor_deployments`
- Stopped worlds greyed out and unselectable in deploy wizard

**CharacterWizard:**
- States step removed (6 steps now)
- Spinner overlay covers `assessRunning` and `generating` states
- Rollback on save failure
- `useEffect` clears stale errors on Review step

**Deploy Wizard:**
- Career section added to Step 1 (level, ladder, employment_type, reputation slider, ✨ Suggest)
- Stopped worlds greyed out with "● stopped" indicator
- Spinner overlay during deploy
- User relationships resolved via `world_memberships` table

**Saga Söderström deployed:**
- Platform actor: `ffe9812a-642a-4f59-819f-60cdb0b379e0`, media_folder: `saga-soderstrom-ffe9812a`
- Simulator actor: `4cae7608-a7c9-4f43-a9ee-75a133ebb591`
- Home: Saltsjövägen, Lidingö (villa)
- Workplace: Nobels väg 5, Solna (Karolinska)
- Relationships: sister→Amber (authored + Dolphin reverse), entanglement→Magnus Klack (authored, player reverse = nil)
- 6 photos + voice reference deployed to simulator

**Bugs fixed:**
- Duplicate Saga marker on map — stale `places` row from previous deploy deleted
- `Float.round` integer crash in encounter prompt — `is_integer` guard added
- `world_presence` duplicate actor marker
- "Unknown" contacts in phone modal — inbox sender IDs added to `name_map` lookup
- `RelationshipEngine.recompute_one/3` crash on multi-dimension pairs — `Repo.get_by` → `Repo.all` + pick highest warmth
- ngrok routing — systemd service was conflicting with manual process on port 4002; simulator tunnel removed from platform config; root URL and `/demo/clark` now correctly served by Nginx
- Login page empty user list — `/api/orgs/:org/members` endpoint restored (was deleted in session 58)



| Session | Date | Key Deliverables |
|---|---|---|
| 33 | Apr 16 | AWS terminated, local AI stack live, work/financial system design, öre currency |
| 34 | Apr 17 | Financial system, vehicles, reputation engine, SMS app |
| 35 | Apr 17 | Clark + Amber seeded, demo WebSocket live, Dolphin3 restored |
| 36 | Apr 18 | Platform/simulator split, TOTP auth, unified world UI |
| 37 | Apr 18 | PubSub SSE, feed privacy, presence, performance improvements |
| 38 | Apr 19 | State model redesign, activity vocabulary v1, schedule architecture |
| 39 | Apr 19 | State model migration complete, schedule_slots (3088), NaiveDateTime fixes, StateVocabulary |
| 40 | Apr 20 | Psychology tables (13 normalised), platform canonical registry, actor editor, share system, UpCloud selected, DiaryEngine designed |
| 41–42 | Apr 21 | Energy recovery fix, SomaticProcess sobriety, meeting system, calendar app, work offer fixes |
| 42 | Apr 22 | VisionProcess, co-presence architecture, location images |
| 43 | Apr 22 | VenueScene, Google Places photos, arrival detection, spawn fix |
| 47 | Apr 23–24 | Relationship status system, encounter persistence, memory fixes, co-presence fix |
| 48 | Apr 24 | Encounter arc, encounter process depth, HermesManager architecture |
| 49 | Apr 24 | HermesManager cold-start fix, bidirectional memory, lean prompts, PresenceView rebuild, scene_description continuity, attachment context score-based |
| 50 | Apr 25 | WorkOfferGenerator extraction + Google Places venue resolution, sobriety DELTAS, knock parse hardening, inbox_messages table fix, overnight log analysis |
| 51 | Apr 25-26 | Energy drain root cause identified (last_engine_tick dual-storage), full Hermes encounter (knock+first_words+dialogue all 70B), encounter memory weight fixes, lean SMS prompt, ROW_NUMBER memory query |
| 52 | Apr 26 | Decision log system, MeetingRunner v2 (Actor↔Actor Dolphin3), Actor↔Actor co-presence pipeline, Promise system (extract+pool entries), HermesManager simplified to URL storage, `num_ctx` removed (was forcing model reload), `ensure_running` eliminated, encounter hang root cause resolved |
| 53–54 | Apr 28–29 | JSON parse fix, first_words gate fix, encounter prompt enrichment (psychology/economic/DISC/objectives), relationship injection (multi-row, 30-day window, full-week meetings, last encounter timestamp), ambient NPC migration to actors table |
| 55 | Apr 29 | **Relationship schema overhaul**: `relationship_dimensions` + `relationship_types` tables, multi-row `actor_relationships` per dimension, `description` + `context` + `started_at` + `ended_at` columns, unique index on dimension. **Ambient actors**: migrated to `actors` table (`actor_type=ambient`), `ambient_npcs` renamed `ambient_location` (pure extension table with FK), engine filters prevent ambient actors booting as full characters. **Encounter enrichment**: `actor_personality` (sexual_orientation, blind_spot, defense_mechanism, paradox, coping_strategies), `financial_note`, DISC dominant dimension, active objectives all injected. Relationship context/description written for all ~90 world relationships. **Marital status** computed dynamically from legal dimension (divorced = ended legal rows, no active). **UI privacy**: encounter memories only shown to viewer who participated; phone messages redacted by viewer_actor_id — character↔character visible to all, user conversations only to participants. **Relationship tab**: one card per person (grouped by target_actor_id), intimate dimension private. Lena Ohlsson (Johan Lundström's ex-wife) wired as ambient actor with ex_wife/ex_husband legal relationship rows. |
| 56 | Apr 29–30 | **SMS relationship scoring**: `RelationshipEngine.score_message/4` calls Haiku after every text, returns warmth/trust/tension deltas (±0.05 max), applied to `actor_relationships`. Frida↔Julia seeded warmth=0.65 trust=0.55. Energy drain fix (P2-9). Platform CharacterWizard rebuilt with 7 steps, photo upload, AI generation, appearance fields. Actor editor panels (Identity, Psychology, Personality, Lifestyle, Economic, Media, In Play). Assessment infrastructure: `assessment_questions` table (234 items + 44 BFI-44), `actor_assessment_results`. Appearance backfill for all actors. Saga Söderström created (brain surgeon, fearful_avoidant, Amber's younger sister). |
| 57 | Apr 30–May 1 | **First/last name split**: `first_name` + `last_name` columns added to platform and simulator `actors` tables. Ecto Actor schema updated. All 12 platform actors backfilled. Simulator actors backfilled. `actor_server.ex` snapshot carries `first_name` (fallback: split name). All 10 "You are #{snapshot.name}" LLM prompts updated to use `first_name`. `encounter_process.ex` uses `actor_first_name`. `engine_server.ex` participants struct carries `first_name`. CharacterWizard now has two separate first/last name fields. ActorsEditorPage IdentityPanel split. **`actor_deployments` table** created on platform: tracks `platform_actor_id` → `world_id` → `simulator_actor_id` mapping. All 11 active simulator actors seeded. **In Play panel**: new "Worlds" nav section in actor editor. Shows per-world: relationships (grouped by person, warmth bars), Memories with you (viewer's own interactions — messages/encounters/conversations), Memories with others (character↔character, grouped per actor, foldable). Privacy model: owner sees all; shared user sees only their involvement + character↔character; other users' player interactions always hidden. Memory counts (core/strong/medium/weak) in world header. **Characters gallery**: split into "In Play · World Name" (foldable, grouped per world) and "Not in Play" sections. Deploy → button on Not in Play cards. **Deploy wizard modal**: 5-step modal overlay (same style as CharacterWizard) — (1) World selector from `actor_deployments` distinct worlds, (2) Relationships with avatar dropdown + chip categories (lawful/romantic/social) + custom label creation, (3) Schedule generator (AI or mock based on occupation), (4) Media panel (portraits + state images + idle/active animation pairs per schedule slot), (5) Review & deploy. Deploy backend stub at `POST /api/actors/:id/deploy` returns 501. Platform server endpoints added: `GET /api/worlds`, `GET /api/worlds/:id/actors` (from platform DB via `actor_deployments` join — no simulator call needed), `GET /api/relationship-types`, `POST /api/actors/:id/deploy`. New character button fixed to open CharacterWizard modal. |
