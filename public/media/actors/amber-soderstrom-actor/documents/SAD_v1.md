# Anima Systems AB — System Architecture Document
### Last updated: Apr 19 2026 (session 38 — state model redesign, activity vocabulary, schedule architecture)

---

## Company & Brand

**Company:** Anima Systems AB — Stockholm
**Tagline:** We Deliver Worlds
**Approved homepage copy:**
- *"What you've built is closer to a novel that writes itself."*
- *"Plans meet psychology. Sometimes psychology wins."*

**Front page:** https://guidebooky-elenora-alone.ngrok-free.dev
**Served from:** Mac Mini (2014) Nginx `/var/www/anima/` on :80/:443
**ngrok config:** `~/.config/ngrok/ngrok.yml` — HTTP→:80, SSH→:22

---

## Infrastructure

**All AWS EC2 instances terminated session 33. No cloud compute running.**

| Role | Machine | IP | Key |
|---|---|---|---|
| Deliver Worlds (world simulator) | Mac Mini Late 2014, Ubuntu 24.04 | 192.168.1.59 | ~/.ssh/id_ed25519 |
| LLM inference + TTS (planned) | Mac Mini M4 2024, macOS, 16GB | 192.168.1.60 | local |

**Remote access (to 2014 Mac Mini):**
- ngrok HTTP: `https://guidebooky-elenora-alone.ngrok-free.dev` → port 80
- ngrok TCP: ephemeral — check current port with:
  ```bash
  ssh magnus@192.168.1.59 "curl -s http://localhost:4040/api/tunnels | python3 -c \"import sys,json; t=json.load(sys.stdin)['tunnels']; [print(x['public_url']) for x in t]\""
  ```
- Port changes on ngrok restart. HTTP domain is permanent.

---

## Mac Mini Services (2014, Ubuntu)

| Service | Port | Notes |
|---|---|---|
| Nginx | 80 / 443 | Serves Anima front page + proxies /worlds, /js, /media, /assets, /live, /ws → :4000 |
| Deliver Worlds (Elixir/BEAM) | 4000 | World simulator, SQLite WAL |
| companion-orchestrator.service | 3001 | Old Node.js orchestrator — inactive, frozen |

### Nginx routing
- `/` → static `/var/www/anima/index.html`
- `/worlds` → proxy Phoenix :4000
- `/js/`, `/assets/`, `/media/` → proxy Phoenix :4000
- `/live/` → proxy Phoenix :4000/live/ (LiveView WebSocket)
- `/ws/` → proxy Phoenix :4000/ws/ (Demo WebSocket)
- `/demo/clark`, `/demo/amber` → static HTML demo pages

---

## Local AI Stack (M4 Mac Mini)

**Machine:** Mac Mini M4 2024, macOS, 16GB — static IP `192.168.1.60`
**Status:** Live and serving the Stockholm world

### LLM — Ollama
- **Active model:** `dolphin3:latest` (4.9GB, GPU)
- **Endpoint:** `http://192.168.1.60:11434/api/chat`
- **Semaphore:** `@ollama_max_concurrent 3` — max 3 concurrent LAN calls, 30s wait timeout

### Models on external drive
| Model | Size | Status | Notes |
|---|---|---|---|
| dolphin3:latest | 4.9GB | ✅ active | Fast, grounded, good character voice |
| gemma4:latest | 9.6GB | ⚠️ available | Strong quality, slower |
| mannix/llama3.1-8b-abliterated | 4.7GB | ❌ avoid | Confabulates conversation history |
| llama3.1:8b | 4.7GB | ⚠️ available | Untested |
| llama3.2:3b | 2GB | ⚠️ available | Too small |
| hermes3:70b | 40GB | ⚠️ remove | Too large for 16GB |

### LLM config
```bash
# /etc/systemd/system/deliver-worlds.service.d/override.conf
Environment=LLM_MODEL=dolphin3:latest
Environment=CLAUDE_API_KEY=sk-ant-...
```

**IMPORTANT:** env var is `CLAUDE_API_KEY` not `ANTHROPIC_API_KEY`

### Demo pages — Haiku
Clark and Amber use Claude Haiku, independent of Ollama queue. `call_ollama` preserved in demo_handler for reference.

---

## Deliver Worlds (Elixir/BEAM)

**Port:** 4000 | **DB:** `~/deliver_worlds/worlds/dev.db` (SQLite WAL)
**Service:** `deliver-worlds.service` — `Restart=on-failure`
**World:** stockholm (`e7368020-fc19-4914-95ac-2f7c5508a13c`) | **Actors:** 12

### URLs
```
Simulator:  https://guidebooky-elenora-alone.ngrok-free.dev/worlds/e7368020-fc19-4914-95ac-2f7c5508a13c
Demo Clark: https://guidebooky-elenora-alone.ngrok-free.dev/demo/clark
Demo Amber: https://guidebooky-elenora-alone.ngrok-free.dev/demo/amber
```

### Key files changed session 35 extended
- `actor_engine.ex` — empty reply guard: `{text, :empty}` suppressed, not inserted
- `actor_server.ex` — `@call_timeout_seconds 600` (was 1800)
- `message_engine.ex` — `String.slice(0, 300)` cap REMOVED from `clean_response/2`
- `engine_server.ex` — news headlines written to world_feed as `entry_type: "news"`
- `world.ex` — `TimeHelper.current_slot` direct (no GenServer), batch balance query, 30s refresh, news in World Events, scroll-to-bottom on phone modal
- `sms_live.ex` — characters included, bubble fix, scroll-to-bottom
- `demo_handler.ex` — Haiku primary, `CLAUDE_API_KEY` env var

---

## Human Process Tree Architecture

```
ActorSupervisor (world-level DynamicSupervisor)
  └── ActorProcessSupervisor (per-actor, :one_for_one)
        ├── SomaticProcess      — vitals, hunger, desire
        ├── PerceptionProcess   — senses, location, NPCs
        ├── AffectProcess       — emotion, mood
        ├── MemoryProcess       — hippocampus, recall
        ├── SocialProcess       — relationships, arc momentum
        ├── DriveProcess        — needs, drives, cooldowns
        ├── ScheduleProcess     — circadian rhythm, obligations
        ├── ObjectiveProcess    — goals, pressure, shame
        ├── VisionProcess       — STUBBED
        └── ActorServer         — coordinator, external API
```

---

## Actor IDs (Stockholm world)

| Actor | ID | Home Place ID |
|---|---|---|
| Frida | 7433c360-c14a-4b42-b5c0-13621d3bea38 | ChIJPxhQdD93X0YRXyxcwTa1Fxo |
| Magnus Petersson | 398d451e-82b6-4f80-9bf5-f8a4f2ea737a | ChIJTREEfgqcX0YRwXIfrGyeLd0 |
| Magnus Klack (user) | magnus-klack-actor | — |
| Julia Höglund | a0987b40-dce1-458c-870a-b188e916834a | ChIJOSsj5cd3X0YRepOkHl8I2xY |
| David Eriksson | 44b629cd-d2c9-43de-901f-7d10833b9eb7 | ChIJ7YG8Qfp3X0YRs2qTH3aj3cQ |
| Emma Sjöström | c95f0aed-6974-4f60-be14-fabfc7492d0a | ChIJBdTbgmWdX0YRvOAj92gBekw |
| Nicole Bergström | 8f60f890-245d-4853-aa88-f4ea32519787 | ⚠️ base64 (geocoder issue) |
| Alex Mattsson | f24b5be8-6247-4ad7-8164-f569fc908a5d | ChIJFYfEbtV3X0YRN1YzZOBQ4zw |
| Sara Karlsson | 65bdeb5b-8852-43aa-bb0d-4a4f62ce6019 | ChIJ12fYTOZ3X0YRmN5aebBds10 |
| Johan Lundström | a5f3f46f-dddb-4f5a-84f2-c7476410acfe | ChIJl4NT_kSdX0YRlbOQdbQiy4w |
| Clark Bennet | clark-bennet-actor | ChIJj_K1h1qdX0YRcr_WWB2qCW8 |
| Amber Söderström | amber-soderstrom-actor | ChIJ7zq3hfd3X0YRshq0QyDXK3w |

---

## Clark Bennet & Amber Söderström

Both `actor_type: "character"`, `employment_type: "employed"`, `work_place_id: ChIJAnimaSystems00Stockholm01` (Birger Jarlsgatan 2)

**Clark:** 34, Head of Sales, Östermalm, secure_anxious, E=0.85, 68,200 SEK, Riddargatan 15
**Amber:** 31, Head of AI Worlds, Södermalm, avoidant_secure, E=0.35, 112,500 SEK, Nytorget 6, cat=Turing

---

## Performance Architecture

### LiveView (world.ex)
- `@refresh_interval 30_000`
- `load_balances_map/1` — ONE query for all 12 balances
- `load_actors/2` — `TimeHelper.current_slot` direct, NO GenServer calls
- Root cause of degradation: GenServer calls into Ollama-blocked actors × 5s timeout × 12 = 60s blocking

### LLM queue
- Semaphore: 3 concurrent max, 30s timeout
- Empty reply guard: timeout → `{text, :empty}` → skip insert → log warning
- Target: <100 LLM calls/hour active

### Call lifecycle
- `@call_timeout_seconds 600` (10 min)
- `@sync_sub_states ~w(on_call on_video_call in_person in_meeting)`
- `maybe_end_stale_call` runs every tick, checks `conv.last_activity_at`
- `clear_stale_sync_state` clears on boot

---

## News System

- SVT RSS fetched once per day (GenServer state `last_news_date`)
- Headlines → `world_feed` as `entry_type: "news"`
- World Events tab: news section (amber ◈) + engine ticks
- Actor prompts: `gt[:news]` → "Swedish news today: ..." via ThoughtEngine
- Force re-fetch: restart service

---

## SMS App

- Route: `/sms`, `/sms/:id`
- Shows `actor_type IN ["companion", "character"]`
- Scroll: `container.scrollTop = container.scrollHeight` on `phx:update` + `phx:page-loading-stop`
- Bubbles: `word-break:break-word; overflow-wrap:break-word; max-width:72%`
- **Message content NEVER truncated**

---

## Platform / Simulator Split

**Architectural commitment, session 36.** Anima is two services with a clear boundary.

```
┌─────────────────────────────────────────────────────────┐
│  CLIENTS                                                │
│  LiveView builder · customer games · scripts · iOS      │
└─────────────────────────────────────────────────────────┘
                         │
                         │  HTTPS + Bearer token (humans)
                         │          or API key (programs)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  PLATFORM SERVICE                                       │
│                                                         │
│  Owns: users, orgs, memberships, TOTP, tokens,          │
│        API keys, world ownership, world membership,     │
│        usage metering, quotas, billing (later).         │
│                                                         │
│  Exposes: /api/v1/* — the product contract.             │
│                                                         │
│  Hosts the LiveView builder UI as one client            │
│  among many.                                            │
└─────────────────────────────────────────────────────────┘
                         │
                         │  X-Service-Token (HMAC-signed)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  SIMULATOR (deliver_worlds)                             │
│                                                         │
│  Pure simulation. OTP tree, tick loop, LLM              │
│  orchestration, SQLite simulation state.                │
│  Internal API only — trusts platform via shared secret. │
│  No users, no orgs, no auth beyond service trust.       │
└─────────────────────────────────────────────────────────┘
```

**The platform is the bouncer. The simulator is the venue.** Everything internet-reachable goes through platform. Simulator sits behind, reachable only by the service vouching for callers.

### Why this shape

- **Clean trust boundary** — TOTP, tokens, rate limits, quotas live in one place.
- **Simulator becomes a clean primitive** — no business logic, no multi-tenancy, just simulation.
- **Enterprise SSO is a platform detail** — simulator never notices when platform swaps password auth for Okta.
- **LiveView is one client of many** — refactoring it to use the API is forced discipline, not optional politeness.

### What moves, what stays

| Concern | Lives in |
|---|---|
| Users, orgs, memberships | Platform DB |
| TOTP secrets, login challenges, invites, auth tokens | Platform DB |
| API keys, scopes | Platform DB |
| World ownership, world membership, actor binding | Platform DB |
| Usage metering rollups, quotas | Platform DB |
| Actors, places, conversations, world_feed, relationships | Simulator DB |
| OTP actor process tree, tick loop | Simulator |
| Ollama / Haiku orchestration | Simulator |
| LiveView builder UI | Platform (hosts), calls simulator via internal API |
| Current `users` / `world_members` in simulator DB | **Vestigial** — migrate out once platform authoritative |

### Trust mechanism

- Shared secret in env var `PLATFORM_SIMULATOR_SECRET` on both services
- Platform signs requests with HMAC; simulator's plug verifies
- Short TTL on signed tokens for handoffs (5 min)
- Simulator HTTP endpoint is internal-only (LAN or localhost), not on public internet
- Rotate secret out of band; rotation causes forced re-auth

### Near-term deployment

Both services run on the 2014 Mac Mini, different ports (simulator :4000, platform TBD :5000). Umbrella project or sibling repo — decision pending. Split to separate machines when scale requires.

---

## API-Is-The-Product

**Every capability the LiveView builder exposes is reachable through the public API.** No shortcuts. The API is the canonical surface; UIs are derivative.

### Implications

- **No "UI can do X but API can't yet"** — that gap is architecturally impossible
- **LiveView builder calls platform's HTTP API**, not Elixir domain modules directly
- **Third-party clients are first-class** — customer's Unity game, Python script, branded React app all equal citizens
- **API versioning matters from day one** — `/api/v1/*`, deprecation policy, OpenAPI spec as customer-facing contract
- **Documentation is a product** — `docs.anima.se` and SDKs are required for enterprise

### Design sequence

1. API schemas first (endpoint paths, request/response JSON, validation, authorization)
2. Scenario walkthroughs (*"to create a world with 5 actors, a script makes these N calls"*)
3. UI wireframes — derived from API

Not UI-first. API-first.

---

## Unified World UI

**The LiveView world dashboard is the universal surface.** Same UI for Anima staff, enterprise customers, solo consumers — scoped by role, driven by API.

- `/worlds/:id` → world dashboard (feed, actors, places, graph, map)
- Exists in the platform service (not simulator)
- Fetches data via platform's HTTP API, same as any external client
- Role-aware rendering: owners see everything; builders see edit tools; players see observe + interact; viewers are read-only
- Same templates, ~20 `if @role in [...]` conditionals

### Scope of reuse

When a customer creates a world, they get *this* LiveView. No separate "consumer app" vs "enterprise tool." One UI, branded per org later via CSS variables + logo slot.

### `sms_live.ex` is scoped, not universal

**`sms_live.ex` is per-embodiment, not a shared surface.** It's the phone UI for a specific `(user, world, player-actor)` triple. Currently hardcoded to Magnus + Stockholm + `magnus-klack-actor`.

When other users get player-actors in their own worlds, they get their own SMS app instance with their own conversations. Same module, strictly scoped data. Not visible to other users, not part of the universal world dashboard.

---

## Actor Taxonomy & Ownership

Three actor types. Differ in how they're driven, who embodies them, and what they cost.

| actor_type | Driven by | Embodied by | Cost profile |
|---|---|---|---|
| `companion` | LLM (rich context, often Haiku) | nobody | High — sessions, deep memory, premium model |
| `npc` | LLM (Ollama typically) | nobody | Medium — ticks, perception, thoughts |
| `user` / `player` | Human keyboard | A real platform user | Lowest — no LLM for voice, still runs psychology |

### Ownership principle

**Every actor has an owner.** Actors inherit ownership from the world they live in. World owner = actor owner.

The owner is always a *platform entity*:
- An `organization` (enterprise customer, Anima, game studio)
- A `consumer user` (solo individual with their own private world)

**Every actor has a payer.** The owner pays for the actor's compute — LLM calls, tick processing, storage. Per-actor metering rolls up to the owner.

### Cost implication for pricing

A world with 1 companion + 100 NPCs is cheaper per actor than a world with 50 companions. Consumer plans likely say *"up to N companions, unlimited NPCs."* Companions are the expensive thing.

### Stockholm's ownership picture

```
World: Stockholm
Owner: Anima Systems AB (organization)
Payer: Anima (internally — this Mac Mini, these Haiku credits)

Actors:
├── 3 companions:  Frida, Clark Bennet, Amber Söderström
├── 8 NPCs:        Magnus Petersson, Julia, David, Emma, Nicole,
│                  Alex, Sara, Johan
└── 1 user/player: magnus-klack-actor (Magnus Klack embodies)

Narrative fact (lives in simulation data, not auth):
  Clark and Amber work for Anima in-world.
  Platform fact (lives in platform data):
  Anima Systems AB org owns Stockholm world.
```

Both can be "Anima" without being the same Anima.

---

## Authentication Model

**TOTP-first, passwordless, invite-based enrollment.** Passwords never stored.

### Flow

1. Admin invites user → email with one-time enrollment link
2. User opens link → sees QR code → scans with TOTP app of choice
3. User enters current code → enrolled
4. Every future login: enter email → enter 6-digit TOTP code → bearer token issued

### TOTP is vendor-neutral

RFC 6238 standard. Any TOTP app works: Google Authenticator, Microsoft Authenticator, Authy, 1Password, Bitwarden, Duo Mobile, Apple Passwords (iOS 17+), open-source (Raivo, Aegis). Backend integrates with TOTP, not any specific app.

### Future auth paths (provision for, don't build)

- **Passkeys / WebAuthn** — likely the long-term primary; `wax` library in Elixir
- **SSO (Okta, Azure AD, Google Workspace)** — SAML/OIDC for enterprise customers
- **SMS OTP** — fallback only (weakest MFA, SIM-swap risk); requires SMS provider (46elks for SE)
- **Magic email links** — low-friction fallback for consumers

All of these trade their own assertion for a platform bearer token. The rest of the system is unchanged when a new auth path is added.

### What the platform stores

- `users.status` — active / suspended / deleted
- `user_totp_secrets` — encrypted base32 secret per user
- `enrollment_invites` — one-time links, short TTL
- `login_challenges` — per-attempt, rate-limited
- `auth_tokens` — bearer tokens (hashed), TTL, revocable
- **No password hashes** — we don't store passwords

### What the simulator stores

Nothing. Auth is not its concern. It trusts the service token.

---

## Authorization & Roles

Three independent levels. Each answers a different question.

### Level 1 — `users.user_type` (who are you?)

| Value | Meaning |
|---|---|
| `staff` | Anima Systems AB employee |
| `organization_member` | Belongs to an enterprise customer org |
| `consumer` | Private individual; own account, own worlds |
| `demo` | Anonymous demo visitor (`demo_token` path) |

### Level 2 — `organization_members.role` (your role in your org?)

| Value | Meaning |
|---|---|
| `owner` | Founder; billing; can delete org |
| `admin` | Manage members and API keys; can't delete org |
| `builder` | Create/edit worlds on behalf of org |
| `member` | View org resources |

### Level 3 — `world_members.role` (what can you do in THIS world?)

| Value | Meaning |
|---|---|
| `owner` | Full control of this world |
| `builder` | Edit actors, places, scenarios |
| `player` | Embody an actor, have sessions |
| `viewer` | Read-only |

### Rule

Levels are independent. Being `owner` of Anima org does NOT auto-grant `owner` on Stockholm — you also need a `world_members` row. One table to query for permission checks. Automation can insert default world_members rows when an org creates a world, but the row is always explicit.

---

## Builder Tool Suite

A suite of five tools. Each is **API-first**: a set of HTTP endpoints is the canonical capability; LiveView is one reference client.

### 1. World Wizard
- `POST /api/v1/worlds` — create world shell
- `POST /api/v1/worlds/:id/from-template` — clone from template
- UI: multi-step form → Review → Create
- Power user: single JSON POST

### 2. Actor Editor
- `POST /api/v1/worlds/:id/actors`
- `PATCH /api/v1/actors/:id`
- `POST /api/v1/actors/:id/profile` — rich profile (personality, attachment, voice)
- UI: tabbed form (Identity / Psychology / Economics / Schedule / Voice)
- Power user: batch JSON upload

### 3. Place Editor
- `POST /api/v1/worlds/:id/places`
- `POST /api/v1/worlds/:id/places/import-google`
- `PATCH /api/v1/places/:id` — facilities, hours, privacy, population
- UI: map-first; click to configure
- Power user: CSV upload

### 4. Scenario Designer
- `POST /api/v1/worlds/:id/scenarios`
- `POST /api/v1/worlds/:id/sessions/planned`
- UI: timeline view; drag events onto calendar
- Power user: scenario-as-JSON, git-versioned

### 5. Narrative Weaver
- `POST /api/v1/actors/:from_id/relationships`
- `PATCH /api/v1/relationships/:id`
- `GET /api/v1/worlds/:id/graph`
- UI: force-directed graph; drag nodes to connect
- Power user: relationship matrix CSV/JSON

---

## Roadmap (updated session 36 — platform-first)

### Platform service build-out

**Session A — Platform scaffold**
- New Phoenix app (umbrella or sibling repo decision TBD)
- Phoenix endpoint, SQLite DB, basic supervision tree
- Core schemas: users, organizations, organization_members, auth_tokens, api_keys, api_key_scopes, world_ownership, world_memberships

**Session B — Auth flow**
- TOTP library (`nimble_totp`) wired
- Enrollment invites (one-time links, email delivery)
- TOTP enrollment flow (QR code rendering)
- Login flow (email → TOTP code → bearer token)
- Invite + enroll Magnus + two Anima colleagues

**Session C — API surface design (no code)**
- OpenAPI spec for `/api/v1/*`
- Endpoint inventory, request/response shapes
- Error model, auth model, pagination, filtering, versioning
- Artifact: `openapi.yaml` → autogenerated customer docs

**Session D — First API endpoint end-to-end**
- Pick smallest useful one (`GET /api/v1/me` likely)
- Build: auth plug → controller → platform domain → simulator internal API → response
- Prove full call chain + service-token trust works
- curl smoke test

**Session E — Simulator internal API + auth plug**
- Define `DeliverWorlds.API.{Worlds, Actors, Feed}` module surface
- HTTP wrapper at `/internal/api/*`
- `PlatformAuth` plug validates X-Service-Token
- Platform's simulator client (HTTP wrapper) in the platform app

**Session F — Platform LiveView dashboard**
- "Welcome, here are your worlds" page
- Signed token handoff to world dashboard
- Role-aware render conditions start landing

**Sessions G–K — Builder tool suite**
- World Wizard (G)
- Actor Editor (H)
- Place Editor (I)
- Scenario Designer (J)
- Narrative Weaver (K)

**Session L — Refactor existing world LiveView to use API**
- Rewire `world.ex` data fetches from Elixir module calls to platform API calls
- `sms_live.ex` same, scoped per-embodiment
- Remove `users` and `world_members` from simulator DB (vestigial)

### Simulator-side TODOs (unchanged from session 35)

1. **Work offer end-to-end** — verify Frida offer → inbox → accept → fee → reputation
2. **Frida DB photo inserts** — 4 photos extracted, inserts pending
3. **NoResponseHandling** — Julia/Emma loop
4. **Demo session memory** — cookie-based visitor memory for Clark/Amber
5. **Moving actor pins on map** — interpolate along transit_polyline
6. **Live world feed on homepage**
7. **Nicole Bergström geocoding** — base64 place_id fix
8. **Chatterbox TTS on M4**

13. **State model migration** — migrate all `schedule_template` slots to `location / main / sub` schema; kill compound state strings
14. **`Anima.ActivityVocabulary` module** — canonical activity list, valid sub lookups, privacy/intimacy eligibility guards
15. **`AvailableActions.generate/3`** — alternatives menu function; psychology-weighted action list per tick
16. **Actor `llm_profile` field** — add to actor schema; engine selects model by context

---

## State Model — Three-Layer Architecture

**Session 38 redesign.** Compound state strings like `eating_cafe`, `home_cooking`, `gym_yoga` are abolished. They conflate location, activity, and modifier into a single opaque string. The new model separates all three.

### Slot structure

```json
{
  "start": "19:00",
  "end": "21:00",

  "location": "ChIJXXoLnIB3X0YRvPxWXwPGcqQ",

  "main": {
    "activity": "social_dinner",
    "with": ["frida-mmuzhy03", "david-eriksson"]
  },

  "sub": {
    "activity": "on_call",
    "with": "magnus-klack-actor",
    "ref": null
  },

  "mood": "sociable",
  "availability": "busy",
  "replyDelay": 300,
  "responseLength": "long",
  "stateNote": "dinner at gallery café"
}
```

### Rules

- **`location`** — always a Google Place ID (or `actor:home`, `actor:work` for resolution at runtime). Never descriptive strings.
- **`main.activity`** — one value from the canonical activity vocabulary. Carries `with: [actor_id]` (array) when others are present.
- **`sub`** — single object, not an array. One concurrent modifier at most. Has its own `with` for dyadic subs (e.g. `on_call` with a specific actor). `ref` holds a `call_id` or `message_id` when pointing to a running process.
- **`sub` absent or null** when no modifier is active.
- **Calls have their own lifecycle** — `sub: {activity: "on_call", with: actor_id, ref: call_id}` is the surface reflection. The call process owns start/end, transcript, emotional state. When the call ends, `sub` clears.

### Migration from legacy compound states

| Legacy | New location | New main | New sub |
|---|---|---|---|
| `eating_cafe` | café Place ID | `eating` | — |
| `home_cooking` | `actor:home` | `cooking` | — |
| `gym_yoga` | gym Place ID | `yoga` | — |
| `social_dinner` at restaurant | restaurant Place ID | `social_dinner` | — |
| `home_evening_wine` | `actor:home` | `drinking_wine` | — |
| `work_deep` at office | office Place ID | `work_deep` | — |
| `eating_home` + on phone | `actor:home` | `eating` | `{activity: "on_call", with: actor_id}` |

---

## Schedule Architecture

### The schedule is a plan, not a law

The weekly `schedule_template` defines what an actor would do *if nothing interesting happened*. It is the baseline prior. Psychology overrides it at runtime.

When the engine evaluates what an actor should do next, it builds an **available actions menu**:

```
available_actions(actor, location, present_actors, time, psychology) → [Action]
```

The scheduled slot is always on the menu. Everything else is generated from context. The LLM picks from the menu. Psychology weights the options.

### Available actions example

```
CURRENT STATE
─────────────
location: home (actor:home)
main: cooking
sub: listening
mood: calm
energy: 0.7
relationship[magnus]: 0.6

DOOR EVENT: magnus-klack-actor arrives unannounced

AVAILABLE NOW
─────────────
① stay on plan        cooking + listening          (scheduled default)
② acknowledge         brief exchange, back to cooking
③ invite_in           social_drinks {with: magnus}  sub: cooking continues
④ invite_in           social_dinner {with: magnus}  pivot fully
⑤ intimacy pathway    only if attraction > threshold
```

### Menu generators

The menu grows as the engine gains capabilities:

- **Location engine** — places have `facilities`, `privacy`, `population`; ambient NPCs become available as `present_actors`
- **Relationship engine** — new states unlock new options (`introduce_self`, `confront`, `confide`)
- **Vitals** — energy/hunger/loneliness surface relevant activities regardless of plan
- **World events** — news, weather, other actors' schedule changes
- **Time of day** — late night unlocks, early morning collapses the menu

### Schedule mutability

Schedules are rewritten by events:

```
event: job_accepted → insert work_adult_shoot slot
                    → displace conflicting slots
                    → recalculate travel + getting_ready buffers
                    → flag at_risk dinner if shoot may run late
```

Triggers for schedule rewrites:
- Job accepted / cancelled
- Invitation accepted / declined
- Spontaneous decision from alternatives menu
- Call runs long
- Location closes
- Another actor changes their plan affecting a shared slot

The original weekly template is the fallback — what the week looks like with no external pressure. Everything else is written on top at runtime.

---

## Activity Vocabulary (v1)

Canonical `main.activity` values. Sub-activities listed per main. `[F]` = flirting possible. `[I]` = intimacy possible (private location + `with` populated required).

### Rest & Recovery
`sleeping` | `waking` (scrolling, on_phone) | `napping` | `meditating` (breathing, guided, silent) | `daydreaming`

### Morning
`morning_routine` (shower, shaving, makeup, skincare) | `grooming` (haircut, nails, facial) | `skincare` (on_phone, listening) | `coffee` (reading, scrolling, journaling, on_phone, on_call)

### Eating & Drinking
`eating` (on_phone, texting, reading, scrolling, watching_tv) | `brunch` (on_phone, texting, reading, people_watching) | `snacking` (scrolling, watching_tv, reading) | `dining` [F][I] (on_call, texting, people_watching, flirting, intimacy) | `drinking_coffee` (reading, scrolling, journaling, on_phone, on_call) | `drinking_wine` [F][I] (on_phone, reading, people_watching, journaling, on_call, flirting, intimacy) | `drinking_alcohol` [F][I] (on_phone, dancing, flirting, texting, intimacy)

### Home
`cooking` (on_phone, on_call, listening) | `meal_prep` (on_phone, on_call, listening, podcast) | `relaxing` [I] (reading, watching_tv, listening, scrolling, on_phone, on_call, intimacy) | `decompressing` [I] (stretching, breathing, bath, on_phone, listening, intimacy) | `creative` (sketching, painting, writing, composing, on_phone, listening) | `philosophical` [I] (journaling, reading, on_phone, drinking_wine, intimacy) | `withdrawing` | `reading` (on_phone, note_taking, drinking_coffee) | `journaling` (on_phone, drinking_wine) | `gaming` (on_call, voice_chat, snacking) | `studying` (note_taking, on_phone) | `admin` (on_call, texting, emailing) | `cleaning` (listening, on_phone, podcast) | `laundry` (listening, on_phone, scrolling) | `errands` (on_call, texting, listening) | `scrolling` (texting, on_phone)

### Watching & Observing
`people_watching` [F] (drinking_coffee, drinking_wine, sketching, on_phone, flirting) | `window_watching` (drinking_wine, journaling, on_phone) | `screening` (note_taking, on_phone, snacking)

### Creative Arts
`sketching` (listening, on_phone, drinking_wine) | `painting` (listening, podcast) | `writing` (listening, on_phone, drinking_coffee) | `composing` (listening, on_call) | `dancing` [F][I] (drinking_alcohol, flirting, on_phone, intimacy)

### Performance
`rehearsing` [F] (script_reading, on_phone, note_taking, flirting) | `vocal_warmup` | `script_reading` (note_taking, on_phone, drinking_coffee)

### Work — Generic
`work_admin` (on_call, emailing, texting, note_taking) | `work_deep` (on_call, texting, listening) | `work_meetings` [F] (on_call, texting, note_taking, presenting, flirting) | `work_reviewing` (note_taking, on_phone, on_call) | `work_casting` [F] (on_phone, note_taking, photographing, flirting) | `work_audition` [F] (note_taking, flirting) | `work_mainstream_audition` [F] (note_taking, flirting) | `coaching` [F] (on_call, demonstrating, note_taking, flirting) | `planning` (note_taking, on_call, sketching) | `pitching` [F] (on_call, presenting, note_taking, flirting) | `networking` [F] (on_call, emailing, texting, flirting) | `negotiating` [F] (on_call, texting, note_taking, flirting) | `scouting` [F] (note_taking, photographing, on_phone, flirting)

### Work — Production
`work_onset` [F] (on_call, waiting, texting, note_taking, flirting) | `work_adult_shoot` [F][I] (on_call, waiting, flirting, intimacy) | `filming` (on_call, directing, note_taking) | `recording` (on_call, monitoring, note_taking) | `mixing` (on_call, note_taking) | `editing` (on_call, note_taking, listening) | `culling` (note_taking, listening) | `storyboarding` (sketching, on_call, note_taking)

### Exercise & Body
`exercise` (listening, on_call, podcast) | `yoga` | `walking` [F] (on_call, listening, people_watching, podcast) | `running` (listening, on_call, podcast) | `cycling` (listening, podcast) | `swimming` | `hiking` (on_call, photographing, listening) | `sport` [F] (flirting) | `stretching` (listening, watching_tv, on_phone) | `foam_rolling` (listening, watching_tv, on_phone) | `massage` [F][I] (on_phone, listening, flirting, intimacy) | `sauna` [F][I] (on_phone, socialising, flirting, intimacy) | `bath` [I] (reading, on_phone, listening, intimacy) | `sunbathing` [F][I] (reading, on_phone, listening, scrolling, flirting, intimacy)

### Social
`social_dinner` [F][I] (on_call, texting, flirting, dancing, intimacy) | `social_drinks` [F][I] (on_call, texting, flirting, dancing, intimacy) | `social_bar` [F] (flirting, dancing, on_call, texting, people_watching) | `social_late_night` [F][I] (dancing, flirting, on_call, texting, intimacy) | `social_cafe` [F] (on_call, texting, reading, people_watching, flirting) | `party` [F] (dancing, flirting, on_call, texting, drinking_alcohol) | `flirting` [I] (texting, on_call, on_phone, intimacy) | `hooking_up` [I] (intimacy)

### Culture
`cinema` [F] (texting, snacking, flirting) | `exhibition` [F] (photographing, on_phone, sketching, note_taking, flirting) | `concert` [F] (dancing, on_phone, photographing, drinking_alcohol, flirting) | `gallery` [F] (sketching, on_phone, photographing, drinking_wine, flirting)

### Personal
`shopping` (on_call, texting, listening) | `spa` [F][I] (on_phone, listening, flirting, intimacy) | `medical` (on_phone, texting) | `therapy` | `childcare` (on_phone, on_call) | `volunteering` (on_phone) | `ceremony`

### Spiritual
`praying` | `reflection` [I] (journaling, on_phone, drinking_wine, intimacy)

### Communication
`texting` | `calling` (walking, cooking, driving) | `listening` (walking, cooking, relaxing, working)

### Transit
`transit` (on_call, texting, reading, scrolling, listening) | `taxi` (on_call, texting, scrolling, listening) | `travel` (on_call, reading, listening, sleeping) | `waiting` (scrolling, texting, on_call, reading, on_phone)

### Intimacy note

`intimacy` is available as a sub on 16+ activities. Any censored LLM (Claude Haiku, default Ollama) can select `sub: intimacy` — it is a state transition label. What the censored model will not produce is narrative detail. The `stateNote` may simply read `"a quiet evening together"`. An uncensored model on the same state generates richer internal simulation-layer content. User-visible output is always filtered regardless of model.

---

## LLM Profile per Actor

Each actor carries an `llm_profile` that governs model selection by context:

```json
{
  "default": "dolphin3",
  "user_facing": "claude-haiku",
  "heavy_generation": "claude-haiku"
}
```

- **`default`** — internal world behaviour (thoughts, state transitions, sub-activity selection)
- **`user_facing`** — messages sent to a human player; always a censored model
- **`heavy_generation`** — transcript backfill, long-form narrative; Haiku or above

**Frida** uses `dolphin3` as default — uncensored, capable of selecting `intimacy` subs and generating appropriate internal state. Her user-facing messages use Haiku.

**NPCs** use `dolphin3` for world behaviour. No uncensored model is required for most NPCs unless their character specifically calls for it.

The engine picks the model based on context, not actor type. The split prevents uncensored content from reaching the user layer while preserving realistic world simulation.

---


## Architectural Decisions

| Decision | Rationale |
|---|---|
| Three-layer state model | `location / main / sub` replaces compound strings. Location carries place. Main carries activity. Sub carries modifier. Separating these makes the engine composable and queryable. |
| Schedule as plan not law | The schedule is a prior. Psychology overrides. The alternatives menu is the decision surface. |
| Available actions as a function | `available_actions(actor, location, present_actors, time, psychology) → [Action]`. Menu grows by adding generators, not rewriting schedules. |
| `sub` is a single object | You can't meaningfully do two sub-activities simultaneously. Single object, not array. |
| `main.with` is an array | A dinner party is multiple actors. `sub.with` is a single actor (call is dyadic). |
| `intimacy` as sub, not main | Intimacy is a modifier on an existing activity, not a standalone state. Location privacy + `with` populated = eligibility. Any model can select it; only uncensored models generate detail. |
| LLM profile per actor | Model selection is context-driven (`default` / `user_facing` / `heavy_generation`). User-facing messages always use censored model. Simulation layer uses whatever the actor profile specifies. |
| Flirting in work contexts | `flirting` is available as a sub in work_meetings, work_casting, work_audition, coaching, networking, pitching, negotiating, work_onset, work_adult_shoot. Reflects realistic dynamics. |
| dolphin3 primary model | Fast, grounded. mannix/llama3.1-8b confabulates history. |
| Haiku for demo | High-value conversations, fast, independent of Ollama queue. |
| @call_timeout_seconds 600 | 10 min sufficient. 30 min caused long stuck-actor periods. |
| Empty reply guard | LLM timeout → suppress insert. Never send blank messages. |
| No message truncation | Messages must be complete. 300-char cap was wrong, removed. |
| LiveView never calls actor GenServers | With slow Ollama, blocks for 5s × 12 actors per refresh. |
| Batch balance query | One SELECT for all balances, not 12 individual queries. |
| CLAUDE_API_KEY not ANTHROPIC_API_KEY | That's what's in the systemd override. |
| No gates — only weights | Psychology as pool modifiers, not if/else blockers. |
| Home = Google Place ID | current_location always a real Place ID. |
| Amounts in subunits (öre) | Integer math only. No float rounding. |
| SGSN principle | Engine manages session state. LLM handles content. |
| SQLite booleans are integers | Insert 0/1 not false/true. |
| Platform / simulator split | Platform = bouncer (identity, authz, billing). Simulator = venue (pure simulation). Clean trust boundary; enterprise SSO stays platform's concern. |
| API-is-the-product | LiveView is a client of the HTTP API, not a direct consumer of domain modules. Forces discipline; unlocks third-party clients. |
| Unified world UI, role-scoped | Same LiveView for staff, enterprise, consumers. Roles gate render paths. One UI to maintain. |
| `sms_live.ex` is per-embodiment | Scoped to (user, world, player-actor). Not a shared surface. Strictly isolated data. |
| Every actor has a payer | Actors inherit owner from world. Owner is always a platform entity (org or consumer user). Owner pays for compute. |
| TOTP-first, passwordless | No password storage. Invite → enroll → TOTP code → bearer token. Vendor-neutral (any RFC 6238 app). |
| Three-level role model | user_type (identity) / org role (membership) / world role (capability). Independent levels; explicit rows, not inherited. |
| Shared secret between services | HMAC-signed tokens for all platform → simulator calls. Simulator HTTP endpoint internal-only. Rotate out of band. |

---

## Critical Principles

- **Mac Mini (2014) runs UTC; actors are Stockholm**
- **No gates — only weights**
- **OTP 26 on Mac Mini** — `naive_datetime_usec` not `utc_datetime`
- **Always pull fresh files from server before editing**
- **The LLM is the voice, not the brain**
- **current_location is always a Google Place ID**
- **CLAUDE_API_KEY** — not ANTHROPIC_API_KEY
- **Never truncate message content**
- **dolphin3 is the primary model** — mannix/llama3.1-8b confabulates
- **Target: <100 LLM calls/hour active**
- **SGSN principle** — engine manages state, LLM handles content
- **Read the symptom directly**
- **No unrequested complexity**
- **Platform is the bouncer, simulator is the venue** — all external trust stops at platform
- **The API is the product** — no capability exists in UI that isn't in the API
- **Every actor has a payer** — world owner pays for all actors in the world
- **Schedule is a plan, not a law** — psychology wins when strong enough
- **State = location + main + sub** — never compound strings
- **`intimacy` is a sub, not a main** — location privacy + presence = eligibility
- **LLM profile is per-actor** — user_facing always censored; simulation layer uses actor's default model
- **No passwords stored** — TOTP is the auth; invites are the onboarding

---

## Deploy Procedures

```bash
# Standard deploy
scp -i ~/.ssh/id_ed25519 ~/Downloads/file.ex magnus@192.168.1.59:~/deliver_worlds/lib/deliver_worlds/file.ex
cd ~/deliver_worlds && mix compile 2>&1 | grep -v warning | tail -5 && sudo systemctl restart deliver-worlds

# Schema change
sudo systemctl stop deliver-worlds && mix ecto.migrate && sudo systemctl start deliver-worlds

# Fix legacy :home strings
sqlite3 ~/deliver_worlds/worlds/dev.db "UPDATE actor_state SET current_location = (SELECT home_place_id FROM actors a WHERE a.id = actor_state.actor_id AND a.home_place_id IS NOT NULL) WHERE world_id = 'e7368020-fc19-4914-95ac-2f7c5508a13c' AND current_location LIKE '%:home';"

# Energy boost
sqlite3 ~/deliver_worlds/worlds/dev.db "UPDATE actor_state SET energy = 0.80, last_slept_at = datetime('now', '-30 minutes'), last_engine_tick = json_set(COALESCE(last_engine_tick,'{}'), '$.vitals.energy', 0.80, '$.vitals.sleep_debt', 0.0) WHERE world_id = 'e7368020-fc19-4914-95ac-2f7c5508a13c' AND actor_id NOT IN ('magnus-klack-actor','clark-bennet-actor','amber-soderstrom-actor');"

# Clear stuck on_call
sqlite3 ~/deliver_worlds/worlds/dev.db "UPDATE actor_state SET current_sub_state = NULL, current_conversation_id = NULL WHERE world_id = 'e7368020-fc19-4914-95ac-2f7c5508a13c' AND current_sub_state IN ('on_call','on_video_call');"

# Boolean fix
sqlite3 ~/deliver_worlds/worlds/dev.db "UPDATE actors SET session_interaction = 0, promotable = 0 WHERE session_interaction = 'false' OR promotable = 'false';"
```

---

## Bug History

### Fixed session 35 extended
- **LLM confabulation** — switched back to dolphin3 from mannix/llama3.1-8b-abliterated
- **Empty message guard** — `generate/2` returns `{text, :empty}`, actor_engine skips insert
- **Message truncation** — `String.slice(0, 300)` removed from `clean_response/2`
- **Call timeout** — `@call_timeout_seconds 1_800 → 600`
- **LiveView degradation** — GenServer calls → TimeHelper direct. Batch balance query. 30s refresh.
- **News in World Events** — engine writes SVT headlines to world_feed
- **Geocoding** — Clark and Amber home_place_id filled, :home strings cleared
- **SMS characters** — Clark and Amber now in SMS contacts
- **Bubble truncation** — CSS fix: overflow-wrap, width:100%, max-width:72%
- **Scroll-to-bottom** — sms_live and world.ex phone modal
- **Demo Haiku** — CLAUDE_API_KEY, max_tokens 1024
- **Router scope** — use Phoenix.Router before scope blocks
- **WS_URL** — wss://host/ws/demo/clark

### Known issues
- Nicole Bergström home_place_id is base64 (geocoder bug)
- Frida DB photo inserts pending
- Emma/Julia NoResponseHandling loop
- Frida schedule_template has frida-mmuzhy03:home strings

---
---

## World State (Apr 19 2026, session 38)

- Session 38 — architecture design, no code changes
- State model redesigned: `location / main / sub` three-layer schema replacing all compound state strings
- Activity vocabulary v1 locked: 94 activities across 16 categories, with sub-activity and intimacy/flirting eligibility mapped
- Schedule architecture formalised: plan-not-law model, alternatives menu, schedule mutability
- LLM profile per actor defined: `default / user_facing / heavy_generation`
- Next build work: implement `Anima.ActivityVocabulary`, migrate schedules, build `AvailableActions.generate/3`
- Actor count: 11 NPCs + 1 user actor (magnus-klack-actor)
