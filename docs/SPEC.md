# AI Roleplay Group Chat — System Manual

> **Audience:** AI implementers and maintainers. This document is the single source of truth for
> the system **as it currently exists**. It contains no history, no process narrative, and no
> rejected alternatives: implement exactly what is written here. If a behavior is not described,
> it does not exist. Chinese identifiers (file names, field names, event vocabulary, source
> labels) are **literal system identifiers** — never rename, translate, or "improve" them.
> Brief `[WHY]` notes bind future implementations; do not remove them, and do not expand them
> into stories.
>
> **Conventions.** `[INV]` marks an invariant: violating it is an implementation error that
> corrupts data or breaks the trust model. `[VERIFIED]` marks behavior confirmed on this machine.

---

## 0. Global invariants

1. **[INV] `剧情.jsonl` is the single source of truth.** Its `msg` lines are the **current
   context snapshot**: user edits, deletions, and rerolls physically rewrite/remove those lines —
   the original wording does not survive anywhere in the log (their ledger-transplant rows are
   rewritten/removed with them). Operational rows — `ledger`, `route`, `presence`, `director`,
   `rename` — are append-only and never rewritten. Derived artifacts (状态.yaml, 记忆.jsonl, 在场.yaml, the dynamic parts of
   性格.md / 人物关系.md) are replayable from the log's ledger/presence rows. The AI never
   rewrites original lines.
2. **[INV] Write order is ledger row first, derived file second.**
3. **[INV] Characters are stateless.** Each turn is one stateless LLM call; all inputs are
   assembled from disk at turn start (`reloadBooks()` clears all caches). User edits to any file
   take effect on the next turn without restarts.
4. **[INV] A character knows only what its knowledge ledger contains.** The ledger is fed
   exclusively by (a) verbatim transplant of messages the fast path judged the character can
   perceive, (b) retelling grants (§5.7), (c) the entry kit (§5.8 scene snapshot + §5.9 off-story
   experiences), (d) explicit user operations. Directors never write memory text.
5. **[INV] Group isolation** at three layers: session, routing roster, storage paths.
6. **[INV] `角色.md` is a user asset with zero runtime write paths.** Only the editor
   (`src/group/scaffold.ts`) writes it.
7. **[INV] Initial character definition is AI-immutable:** 初始姓名 (角色.md frontmatter),
   初始外观 (角色.md), 初始背景 (角色.md body), 初始性格 (性格.md base), 初始人物关系
   (人物关系.md base). No runtime path may modify them. All dynamics live in the status ledger
   (§3.4a).
8. **[INV] Memory text is never generated — with two deliberate exceptions.** Ledger entries are
   verbatim transplants of message text (plus a speaker prefix). No model may summarize,
   paraphrase, or extend them. Directors have no memory-append capability on the play path; only
   the correction window may add memory, and only on explicit user request. The exceptions (both
   user-approved, retractable like any other entry): the scene-perception snapshot (§5.8,
   `source = 现场所见`) — no verbatim source exists for what a newly-arrived character *sees*; and
   off-story experiences (§5.9, `source = 离场经历`) — no verbatim source exists for what a
   character *lived through* while off-scene. Both are tightly constrained; §5.9 additionally
   renders one version per participant so shared events never contradict across memories.
9. **[INV] Prompt discipline:** system prompts and tool descriptions state principles and
   categories only. No concrete scene examples. `[WHY]` examples bias judgment.
10. **[INV] The judgment log (判定.jsonl, §3.2a) never enters any character or director context.**
    It exists for humans only.
11. **[INV] The repository contains no example content.** All test fixtures are temporary and
    deleted on exit, including failure paths.

---

## 1. Runtime shape

Participants: 1 user + N characters (0 is legal; `speak` prompts to create one first) + 1
director split across: a fast decision model (Jev, §6.1a), a slow bookkeeper (deepseek, §6.1b),
a fallback full director (deepseek, §6.1c), and a correction window (§6.3).

### 1.1 Turn lifecycle (user public speech)

`GroupSession.speak(text)` (`src/group/engine.ts`):

1. Drain the background queue (the previous turn's bookkeeping must finish first), then
   `reloadBooks()`: discard in-memory caches; re-read character files, 规则.md, 用户.md, and
   群设定.yaml from disk. Disk is the source of truth [INV 3].
2. If the log has no presence line yet, append one for the current scene (reason `初始`).
3. Fast-path pre-flight (only when `settings.routerId` points at an existing provider): one Jev
   call (`jevRoute`, §6.1a) answers who speaks next, three-layer scene corrections (flat groups)
   or scene-change + per-character locations (map groups), the knowledge set for this message,
   the retelling trigger set (§5.7), and the status-ledger gate. If the call itself fails →
   `undefined` → whole turn to the full director. If only the **route pick**
   is unusable (low confidence / out-of-roster — typical for pure-narration messages) →
   `picked` is returned empty: routing falls back to the full director while scene / knowledge /
   retelling / gate judgments from the same answers still apply (each is threshold-guarded and
   stands on its own).
3a. Map groups: apply the scene move **before** the user message — ⊘ manual pick, or the
   `scene_change` answer (confidence-guarded; strict). Followers (present ≥0.7) move with the
   user; leavers (present ≤0.3 among the previous occupants) fall where their `location_<角色>`
   answer says (a created scene, or 其他 = off-map); ambiguous keeps. The destination's colocated
   occupants hear the arrival line.
4. Append the user `msg` line. `visible_to` = knowledge audience (§4.3/§4.4): the Jev `knows` set
   filtered by per-link `since` anchors; when the fast path is unavailable, fallback =
   present ∩ full perception (keyword rule). The snapshot is written at birth — context window and
   memory agree from the first moment.
5. `backfillAll()`: transplant new visible messages verbatim into each character's ledger (§5.2)
   and heal stale entries (§5.3). Then, if the retelling trigger set is non-empty, stage-2 extra
   memory runs synchronously (before routing — a relayed-to character must already hold what was
   retold to him, §5.7).
6. Apply scene corrections (fast-path `scene`, map dialogue-entrants/leavers, or fallback
   director `presence_updates`) — **after** the snapshot: characters entering now hear the next
   message, not this one. Names are normalized
   via `resolveCharacterName` ("甲" matches "角色甲"); unmatched names are dropped.
7. Entry-kit trigger (§5.8/§5.9): present-after minus present-before (flat) / location-changed
   entrants (map, pure code) → background kit for entrants.
8. Append the `route` row and emit the route event. If the picked speaker has no speech rights
   (not in 现场 ∪ 接入 — e.g. single-direction overhearers), emit an info prompt and end the turn
   without calling the character model (the gated bookkeeper may still run on the user message).
9. `speakAs`: assemble inputs (§6.2) → stream tokens (`delta` events) → `stripNameEcho` →
   **merged post-reply judgment** (`jevAfterReply`, one call: reply knowledge audience + status
   gate + retelling triggers + relay; independent of the user message's judgment) → append the
   character `msg` line (listeners = [self, audience]) → `reply` event. Empty input or an empty
   reply yields an info event and no msg line.
10. Relay (fast path only): the merged judgment's `next_speaker` (§6.1a) picks the next speaker
    with **the user as a candidate**. Retelling triggers from the reply are granted (§5.7) before
    the next hop speaks. A character → append route row and loop back to step 9 (hops + 1). The
    user, a failure, or low confidence → end of chain. There is **no hard cap**: each speaker's
    weight is a cumulative multiplier that `RELAY_DECAY`s at every judgment (×0 for the judgment
    right after a speech — that judgment does not advance the multiplier; re-speaking never resets
    it), while the user's weight never decays — the weighted argmax eventually lands on the user
    and the chain ends by itself.
11. Bookkeeping. Fallback path: apply the director's ledger updates inline. Fast path: **gated** —
    the work list holds the user message and each reply whose judgment opened the status gate
    (missing answer = open); an empty list means **no bookkeeping call at all**; otherwise one
    background job runs `askBookkeeper` (§6.1b) once per list entry, serialized on the session
    queue; failures are logged and never fatal. Either way, ledger row first, then derived file
    (§5.4). The background queue does not emit real-time `ledger` events; results become visible
    after refresh.
12. Final `backfillAll()`.

### 1.2 Other operations

- **No private-chat channel exists.** To speak privately, write it in the message body ("我凑到
  某人耳边低声说……"); who perceives it is judged like any other message.
- **`roll()`**: regenerate the last character message from the same visible input minus that
  message, temperature 1.0; the log's msg line is **rewritten in place** and memory entries
  referencing the message are rewritten to the new text (§5.6).
- **`editMessage(id)`**: the log's msg line is **rewritten in place** with the new wording;
  memory entries (and their ledger rows) referencing the message are rewritten to the new text
  (§5.6).
- **`deleteMessage(id)`**: the msg line **and every ledger-transplant row referencing it are
  removed from the log** — the text survives nowhere. Every character's memory loses the entry
  (files updated directly; no retract row is needed since the mid can never be reused, see
  `header.lastMsgId` in §3.2). Deletion means the message never happened.
- **`correct(text)`** (§6.3): out-of-band conversation with the director; results apply as scene
  corrections, memory retracts/appends, ledger snapshots, and are archived as `director` lines.

---

## 2. Stack and processes

| Item | Choice |
|---|---|
| Runtime | Node.js ≥ 22.19, TypeScript, ESM, pnpm workspace (root + `web/`), tsx runs `.ts` directly |
| Character LLM | OpenAI-compatible chat completions via the official `openai` SDK (`src/llm/deepseek.ts`); default `deepseek-flash` with `reasoning_effort: high` |
| Fast-path judge | TypeSafe System-One-protocol decision model (e.g. Jev via a relay), native `POST {baseUrl}/v1/systemone`, called through `undici` with optional proxy (`src/llm/jev.ts`) |
| Server | hono + @hono/node-server; NDJSON event streams for conversation; port `HOST_PORT` (default 8787) |
| Frontend | React 18 + Vite (`web/`), dev proxy `/api` → 127.0.0.1:8787, port 5173 `strictPort` |
| Storage | Pure filesystem (`node:fs`); no database |

- Thinking-mode facts `[VERIFIED]`: `tool_choice` only accepts `auto`; a required function is
  enforced by strong prompt + function-name validation + a bare-JSON fallback parse of the message
  body (`src/llm/deepseek.ts`). `reasoning_content` never enters the story. The OpenAI client is
  cached by `baseUrl|apiKey`, `maxRetries: 2`.
- Tool argument tolerance: array-typed schema fields are wrapped through `asArray` when a model
  emits a single object instead of an array.
- Environment keys (all optional): `HOST_PORT`, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`,
  `DEEPSEEK_REASONING_EFFORT`, `DIRECTOR_TIMEOUT_MS` (default 30000), `JEV_TIMEOUT_MS`
  (default 4000), `DEEPSEEK_MAX_TOKENS` (default 8192 — explicit per-generation token ceiling:
  without it the API default budget is consumed by deep thinking, producing "typing indicator but
  empty output"), `RELAY_DECAY` (default 0.8, §6.1a relay
  decay), `CONTEXT_WINDOW` (default 36, message window), `HTTPS_PROXY`/`HTTP_PROXY` (used by
  the Jev client for outbound calls; localhost endpoints are exempt).
- `settings.yaml` holds provider credentials and is gitignored.
- Startup self-heal: server and CLI call `healOrphanSettingsBackup()` — if an offline selfcheck
  was hard-crashed mid-run and left a mock `settings.yaml`, the orphaned
  `settings.yaml.selfcheck-bak` is restored automatically.

---

## 3. Data formats

### 3.1 Layout

```
<workspace>/
  规则.md                     # global rules written by the user; injected into director + all characters
  settings.yaml               # provider list + activeId + routerId (gitignored; holds credentials)
  .env                        # optional keys (see §2); gitignored
  groups/                     # user data, gitignored
    <群聊名>/
      群设定.yaml             # era / world / tone / scene（初始当前场景）
      场景/                    # 地图：一个场景一个 md 文件（§3.5a）
      用户.md                 # user persona (frontmatter name + free prose)
      在场.yaml               # scene cache derived from presence rows (§3.9)
      剧情.jsonl              # event log = single source of truth; msg lines are the current context
      判定.jsonl              # judgment/run log for humans only (§3.2a); never enters any context
      角色/
        <角色名>/             # directory name = character dirName
          角色.md             # user asset: frontmatter name/appearance + background body (read-only)
          性格.md             # user initial personality only (AI never writes)
          人物关系.md         # user initial relationships only (AI never writes)
          状态.yaml           # status ledger: fixed seven fields (§3.4a)
          记忆.jsonl          # knowledge ledger: verbatim transplants (§5)
```

### 3.2 剧情.jsonl

First line: `{"type":"header","group":"<群名>","created":"<ISO8601>","v":1,"lastMsgId"?}` —
`lastMsgId` is the highest message id ever issued; it keeps ids from being reused after a
physical deletion (old files lack it; it is computed on open and persisted on the first rewrite).
Then one JSON object per line:

| type | fields | notes |
|---|---|---|
| `msg` | `id, role(user\|character\|system), name, text, round, visible_to("all"\|[名]), ts` | `id` is monotonic: `nextMsgId = max(header.lastMsgId, existing ids) + 1`. **User edits/deletes/rerolls physically rewrite/remove msg lines** — the log is the current context. `visible_to` = knowledge-audience snapshot taken at append time (§4.4). |
| `route` | `round, picked, reason, fallback` | one per director decision (including each relay hop; relay rows carry reason `接力`) |
| `presence` | `scene?, locations?{角色: 场景}, present[], remote?[{character, perceive(语音\|视听), note?, since?}], overhear?[{same}], reason, ts` | scene change (§4); map rows carry the active scene and every character's location (missing key = 其他); omitted layers = unchanged |
| `ledger` | `character, section(status\|knowledge\|personality\|relationship), op(set\|append\|unset\|retract), content` | payloads in §3.3; `personality`/`relationship` sections are retired (replay ignores them) |
| `director` | `text, reply, applied[], ts` | correction-window archive; never shown to characters (§6.3) |
| `rename` | `from, to, ts` | character rename; historical rows are mapped to the current name via the name chain (§3.10) |

- **Effective view `effectiveMessages()`**: the msg lines verbatim — the log IS the current
  context. Everything character-facing (assembly, backfill, last speaker, heuristic routing)
  uses this view.
- **Bad-line policy**: lines failing `JSON.parse` are ignored (a torn tail line must not lock the
  group). New message ids skip gaps (max existing id + 1, floored by `header.lastMsgId`).

### 3.2a 判定.jsonl (judgment/run log; humans only)

Append-only, one JSON row per judgment or bookkeeping action, written by hard-coded code at each
judgment site (`judgeLog`). **It never enters any character or director context** — it exists so
humans can audit what the backend actually decided instead of guessing from the chat column.
Phases: `主判定` (the per-turn Jev call: picked, confidence, scene kept/changed, `sceneChange`
(map groups), `knows`, `told`, `stateDirty`, `elapsedMs`, and `answers` — every question's raw
answer including probabilities),
`回复判定` (the merged post-reply call: audience, told, gate, relay), `额外记忆判定` (stage-2:
candidate rounds, granted rounds), `总管路由` (fallback director result), `记账` (gate skip note
or per-entry deepseek bookkeeping outcome), `现场所见` (scene-perception snapshot: targets and
summary, or trigger note, or failure), `事件补全发现` / `离场经历渲染` / `事件补全` (§5.9:
discovered events, per-participant render, injected memory; failures included), `纠正` (correction
window applications). Failures are
logged with their reason. Served to the frontend via `GET /api/group/{name}/judgments` (§7.2).

### 3.3 ledger payloads (applied by `applyLedgerEvent`; shared by live path and rebuild replay)

| section + op | content | effect |
|---|---|---|
| status + set | JSON object, subset of the seven ledger fields (§3.4a) | per-field overwrite into the character's ledger (fields absent from the JSON keep their value) |
| knowledge + append | `JSON({source, mid?, round, text})` | verbatim ledger entry; `source` is `亲历` (transplant), `额外得知` (retelling grant, §5.7), `现场所见` (scene snapshot, §5.8), `离场经历` (off-story experience, §5.9), or `用户指定`/`推断`/`他人告知` (correction window) |
| knowledge + retract | `JSON({mid? \| text?})` | removes matching entries; a `mid` retract also adds the mid to the suppression set so backfill can never re-register it |

### 3.4 Character files

| file | writer | structure |
|---|---|---|
| 角色.md | editor only | frontmatter `name`(default = dirName), `appearance`; body = background |
| 性格.md | editor only | `# 性格` + user initial personality. No AI-written section. |
| 人物关系.md | editor only | `# 人物关系` + user initial notes. No AI-written entries. |
| 状态.yaml | Host only (director snapshots §6.1b/§6.1c, user PUT §7.2) | status ledger, fixed seven fields (§3.4a) |
| 记忆.jsonl | Host (transplant + grants + snapshot + retracts), user (panel) | one JSON object per line: `{"source","mid"?:n,"round":n,"text"}` (fixed key order) |

All reads strip a UTF-8 BOM. All serialization is deterministic (byte-identical for identical
state) — rebuild idempotence depends on it.

### 3.4a Status ledger (状态.yaml)

The single home of everything dynamic about a character. Fixed seven fields, **whole-snapshot
semantics** (only the latest version is stored; nothing accumulates — stale state must never
pollute prompts). The ledger is a **skeleton of objective facts, not prose** — writers (§6.1b/§6.1c
tool descriptions and prompts) must keep entries short and observational `[WHY]` a florid ledger
gets echoed verbatim by characters as repeated stock phrases):

```yaml
生理状态: "…"      # body / injuries / stamina / senses
心理状态: "…"      # emotions / desires / fears / attitudes
外观状态: "…"      # clothing / grooming / visible changes
位置状态: "…"      # current location and posture
性格演变: "…"      # current deviation from the initial personality (persistent shifts only)
姓名变化: "无"     # or the current alias/title (affects speech only; the archive name never changes)
人物关系变化: "…"  # current stance toward each other character
```

- **Injection** (`ledgerPrompt`): the seven lines, exactly in this format, into the character
  system prompt, prefixed with "你此刻的最新状态，以此为准；与更早的对话内容冲突时，以这里为准".
- **Update** (`recordRouteChanges`): directors emit a `状态账本` array (§6); per character, the
  provided fields overwrite the ledger, omitted fields carry forward, and unchanged characters are
  skipped. One status snapshot ledger row (JSON of the merged seven fields) is appended per
  changed character, then 状态.yaml is rewritten.
- **Normalization** (`loadFiles`): 状态.yaml is normalized to the fixed seven fields; 性格.md /
  人物关系.md carry only user content.

### 3.5 群设定.yaml

```yaml
era: <era text>
world: |
  <world, multi-line>
tone: |
  <director tone; optional; director-only, never sent to characters>
scene: <初始当前场景名>   # 建群时指定；此后只随 presence 行演进
```

### 3.5a Scenes (场景, the map)

`groups/<群>/场景/<场景名>.md` — frontmatter `name` + body = the scene description. One scene,
one file. **Names are immutable and scenes cannot be deleted** (positions reference them by
name); descriptions are user-editable. The only writers are the user surfaces (scaffold group
creation, 场景 page, HTTP scene endpoints) — the engine and every AI path are read-only.
`listScenes()` returns all scenes sorted by name. Every scene's full text is injected into every
character each turn (§6.2) and into the judge's state (§6.1a) — the map is what makes presence a
code fact instead of a guess.

### 3.6 用户.md

Frontmatter with optional `name` (default `你`) — how the user is addressed in the story — plus
free prose. Injected into every character and the director.

### 3.7 规则.md

Workspace-root file; user-written rules injected into the director and every character (as the
`【规则（用户设定）】` section, before the closing instruction). A missing/empty file injects
nothing (no built-in content). Re-read every turn. No size budget: injected verbatim `[WHY]` the
user accepts the per-turn cost rather than losing rules; it is the only injected section without
a size limit (§5.5 bounds memory only).

### 3.8 settings.yaml

```yaml
activeId: <provider id for character generation + slow bookkeeping; empty = fall back to .env>
routerId: <provider id for the fast-path judge; empty = fast path off>
providers:
  - { id, name, baseUrl, apiKey, model, reasoningEffort(off|low|high|max) }
```

Entries missing baseUrl/apiKey/model are ignored. `activeId` falling on a missing entry falls back
to the first provider. `routerId` falling on a missing/ignored entry disables the fast path (the
director runs the single full call). The fast-path provider must
serve `POST {baseUrl}/v1/systemone` with the TypeSafe native protocol; the AIHubMix relay
(`https://api.inferera.com`, `model: jev-latest`) is a known-good choice.

### 3.9 在场.yaml (derived cache; source of truth = presence rows, §9)

```yaml
present:            # on scene
  - <角色名>
remote:             # two-way linked: perceives here AND can be interacted with here (may be absent)
  - character: <角色名>
    perceive: 语音  # 语音 (sound only) | 视听 (sound + picture)
    note: <free text>
    since: 12       # this link's perception anchor (message id snapshot; Host-maintained)
overhear:           # one-directional perceivers (can know, cannot interact; hidden from scene members)
  - character: <角色名>
    perceive: 语音
    note: <free text>
```

### 3.10 Names and compatibility

- Name validity (group names, character names, `:dir` params): non-empty, ≤60 chars, no
  `\ / : * ? " < > |` or control chars, not `.`/`..` (path traversal guard). Duplicates rejected.
- Renames are refused when the new name collides with another character; a legal rename appends a
  `rename` row. `store.nameOf()` maps any historical name through the chain to the current name;
  ledger replay, scene restoration, and rebuild all resolve through it (renaming never loses
  history or evicts the character from the scene).
- Unknown frontmatter fields in any user file are ignored.

---

## 4. Scene and perception

**Map groups** (群设定.scene set): space is fixed by the map (§3.5a). Every character has a
**location** (one of the created scenes, or 其他 = off-map); the **active scene** is where the
user is (⊘ manual pick, or the scene-change judgment below). Presence is a **code fact**:
`present` = characters whose location equals the active scene — no model guessing. What the judge
decides each turn is (a) whether the user **explicitly moved** to a created scene (extremely
strict binary: only an explicit depiction of arriving/entering counts), (b) per character, whether
the dialogue **explicitly** depicts him entering (then his location becomes the active scene) or
leaving (his location becomes his `location_<角色>` answer — a created scene, or 其他 when the
dialogue does not say or the place is off-map), and (c) who can perceive the message. Characters
colocated in the destination scene are there by record — they hear the arrival line, and they are
**not** entry-kit targets (nothing is new to them); only characters whose location changed are
(§5.8/§5.9).

**Flat groups** (no scenes): presence is the explicit list judged abstractly as before — the judge
asks whether someone has *any way* to perceive and whether the scene can *interact* in real time;
means are never enumerated and never keyword-matched. Slow-director and correction-window
`presence_updates` (with the optional `scene` field) correct both modes; the frontend only
displays.

### 4.1 Three layers

| | 现场 present | 双向接入 remote | 单向感知 overhear |
|---|---|---|---|
| judged as | in the scene | can perceive here **and** can be interacted with here, right now | can perceive here but no real-time interaction (eavesdropping, surveillance, …) |
| speech | yes | yes | **no** (must become present or linked first) |
| knowledge | auto-transplanted when judged perceiving (§4.3) | same transplant model, gated by `since` | same transplant model, gated by `since` |
| visible to scene members | — | — | **never** (scene members must not know they are being overheard; only the director and the player see this layer) |
| action | full | only through the link | none |

Delayed one-way delivery (letters, deferred messages) is not perception: the target does not
learn anything unless narrated as a retelling (§5.7) or supplied by the player (memory panel /
correction window).

### 4.2 Normalization and speech rights

- `normalizeScene`: keep existing characters only; layer priority 现场 > 接入 > 单向感知. Map
  groups: `present` is derived from `locations` (location == active scene), so an explicitly
  edited present list re-writes those characters' locations (checked = active scene) and never
  touches the unchecked ones' locations.
- `speakableNames()` = present ∪ remote. The routing roster contains only speakable characters;
  an empty roster falls back to all characters (anti-stall), and the final interception check
  still blocks a pick without speech rights.
- Tool `presence_updates` semantics per layer: field omitted = layer unchanged; empty array =
  layer emptied.

### 4.3 Knowledge judgment (fast path) and keyword fallback

- Fast path: for every message (user speech and each character reply) and **every character**, one
  noul question — "can this character perceive the content of this message?" — judged from the
  narrative, scene notes, and the character's status text (whispering, turned away, distance,
  impairments, channel limits). ≥0.5 → in the knowledge audience; <0.5 → fully excluded (context
  and ledger). Map groups: characters colocated with the speaker (in `present`) are in the
  audience by record unless the judgment explicitly says they cannot hear (a missing answer keeps
  them in — they are standing there).
- Fallback (fast path unavailable): audience = present ∩ full perception, where the reserved
  status field `感知` (or `感官`) wins over a scan of all status fields (`失聪|耳聋|听不见|聋` →
  no hearing; `失明|眼瞎|瞎|看不见` → no sight). Conservative: when in doubt, include (the
  director and the correction window can remove; a missing perception is recoverable, a wrong one
  leaks).
- Retellings (`told_<角色>`) are a separate judgment that feeds extra memory (§5.7); they do not
  alter `visible_to` — being told something is not perceiving the narration scene.

### 4.4 visible_to

Every msg line carries the knowledge-audience snapshot in `visible_to` (the speaker is always
included). User messages: on a map group the **scene move (judged or ⊘-picked) is applied before
the snapshot** — the destination's occupants hear the arrival line; dialogue-summoned entrants do
not (the snapshot precedes their entry). Character
replies: judged after streaming completes, before append, independently of the user message's
judgment (not hearing one whisper does not imply not hearing a later shout). `visible_to` governs
both the message window (§6.2) and ledger transplant (§5.2) — context and memory agree from
birth. Deleted messages are excluded from the view and their ledger entries removed (§5.3).

### 4.5 Linked and overhearing characters

Their perceived messages follow the same transplant pipeline as everyone else, filtered by each
link's own `since` anchor: messages at or before the anchor (i.e. before the link existed) are not
theirs. New links anchor just before the last user message, so the utterance that caused the link
is heard. The system prompt declares each link's limits and the overhear variant adds that
the scene cannot interact back.

---

## 5. Knowledge ledger

### 5.1 Principle

An entry is **verbatim** content the character was judged to perceive: `说话人：<原文>` (own
messages: `你自己说过：<原文>`). No truncation, summarizing, or rewriting at transplant time;
`buildMemory` applies the injection budget at assembly time.

### 5.2 Backfill (`backfillKnowledge`)

Runs after every append. Iterates the **effective view**; for each character, any visible message
without a ledger entry for its `mid` is transplanted as `source=亲历` with the `mid` (restart
idempotent). Every new entry is also appended as a ledger row [INV 2]. Entries whose `mid` is in
the suppression set are never re-registered (§5.3). Suppression source: user retracts.

### 5.3 Manual memory operations (user; via ledger)

- Add: `source=用户指定` append (affects only that character).
- Retract: by `mid` (preferred) or by exact text; a `mid` retract also suppresses the mid against
  future backfill.
- Deleting a message physically removes its line and ledger rows; `backfillAll` additionally heals
  any entry whose `mid` references a message that no longer exists in the log at all.

### 5.4 Bookkeeping write order

Ledger row first, then the derived file (`saveStatus/saveMemory/savePersonality/
saveRelationships`). Sources: knowledge transplant (§5.2), retelling grants (§5.7),
scene-perception snapshot (§5.8), status-ledger snapshots (§6.1b/§6.1c), correction-window
changes (§6.3), manual edits (§7.2). **Directors never generate memory text** — their tools carry
no memory fields.

### 5.5 Injection budget (`buildMemory`)

Newest entries first, total budget 6000 chars; entries overlapping the last `CONTEXT_WINDOW`
(default 36) visible messages are skipped (the message window already carries them). Entries are
verbatim; the budget truncates injection, not the stored text.

### 5.6 Living ledger

Editing or re-rolling a message rewrites every ledger entry referencing it to the new verbatim
text — the log's ledger rows are **physically rewritten** (no retract/append pair; the old
wording does not survive in the log) and the memory file is updated in place. The suppression set
is respected — a user-retracted mid is never rewritten back into existence. Deleting a message
physically removes its line and its ledger rows outright (§1.2). Extra-memory entries (§5.7)
carry the original `mid`, so all of this covers them automatically.

### 5.7 Extra memory (retelling transplant, fast path only)

A message narrating an off-screen retelling ("I told X what we discussed") does two things: the
narration line itself enters the ledger of whoever perceived it (§5.2), and the retold content is
granted to the told character as **extra memory**:

1. **Stage 1** (a `told_<角色>` question inside `jevRoute` / `jevAfterReply`): "is this message
   telling X something he does not know?" ≥0.5 triggers stage 2 (low bar — it only decides
   whether to spend one more cheap call; missing answer = not triggered).
2. **Stage 2** (`jevExtraRounds`, one call per triggered character, synchronous — before the next
   speaker is assembled): candidate rounds = rounds holding messages missing from that character's
   ledger, newest 8, each summarized by its first missing message (`missingRounds`, pure code).
   One `round_<N>` noul per candidate; ≥0.75 → that round's messages the character lacks are
   transplanted verbatim (`transplantRounds`), `source = 额外得知`, keeping the original `mid` and
   `round`, appended at the end of the ledger. Every new entry gets its ledger row (§5.4) and an
   info event names the granted rounds.

The `mid` linkage gives extra entries the full living-ledger semantics for free: idempotent
(re-granted rounds yield nothing), retractable by mid/text (memory panel, correction window),
rewritten when the original message is edited or re-rolled, retracted when it is deleted. Failure
at any point grants nothing (status quo ante). `JEV_THRESHOLDS.toldMin / extraRoundMin` are the
two thresholds.

### 5.8 Scene-perception snapshot (现场所见)

Messages cover what was *said*; they do not cover what a character *sees* on arrival (the corpse
in the room was described in messages he never received). When a turn's scene corrections bring
in characters who were not in the scene at turn start (pure code: present-after minus
present-before; no Jev cost), the system generates **one** observable-state description and
injects it into every entrant's ledger (`source = 现场所见`, no `mid`, current round). Map
groups narrow the entrant set to characters whose **location changed** into the active scene —
followers and dialogue-summoned entrants; characters colocated in the destination by record are
not entrants (nothing there is new to them):

- `askSceneSummarizer` (deepseek, `record_scene` tool) reads the present notes, **all**
  characters' status ledgers (traces of the absent — a corpse — belong to the room), and the last
  12 effective messages, and must output a 2–4 sentence plain description of what is observable
  *right now*: postures, positions, injuries, clothing, expressions, blood, traces, furnishings.
  Hard constraints (enforced in the tool description and prompt): no history recap, no inference
  of who did what, no inner states (visible expressions/actions are fine), no foreshadowing,
  metaphor, exaggeration, or evaluation; "现场无异样" when nothing stands out. This is the
  system's only generated memory (see [INV 8]).
- **Ordering**: the generation runs in the background; if the relay judgment hands the floor to
  an entrant, `speakAs` waits for the snapshot to land before assembling that reply — the
  entrant must see the scene before speaking (the reverse of normal bookkeeping, which is
  post-reply background). A status note ("（X 环顾四周……）") marks the wait.
- Failures or empty summaries grant nothing (manual memory panel still works). Entries are
  retractable via the memory panel / correction window. **Manual presence fixes
  (`PUT presence`) trigger the snapshot too** for the characters the fix brought in — entering
  means seeing, regardless of who updated the roster. Bookkeeper-driven scene corrections do not
  (they run after the turn and the next turn's diff covers them).

### 5.9 Off-story experiences (事件补全 / 离场经历)

The story runs on multiple threads: while a character is off-scene, things happen to him (orders
given to others get fulfilled, appointments kept, relationships moved). Messages only carry the
on-scene thread, so a returning character's memory ends at his last departure. When the entry kit
fires (§5.8 trigger, same pure-code diff), re-entrants — characters whose last departure can be
located in the presence history (`store.absenceStartId`, pure code; first-time entrants have no
window and are skipped) — additionally get their off-screen life simulated and injected:

1. **Discovery** (`askOffStoryDiscovery`, `record_offstory` tool; one call per entry covering all
   re-entrant entrants collectively): input = each entrant's absence-window dialogue (effective
   messages after their departure id, capped at the last 40) + **all existing `离场经历` entries**
   (anti-repeat / anti-contradiction anchor) + the roster. Output = up to 4 events, each a
   one-sentence objective skeleton (`summary`) + full `participants` list (≤4). Hard constraints:
   only extend what the dialogue gives grounds for (orders to him, promises, invitations,
   relationships, others' stated intentions about him — reasonably simulate their fulfillment);
   mundane only (no deaths, major turns, or new characters unless the dialogue directly supports
   them); no literary style; empty array when nothing qualifies. Empty/failed discovery grants
   nothing.
2. **Per-participant limited-POV rendering** (`askOffStoryPOV`, `render_memory` tool; one call
   per event × participant, in parallel): input = the event skeleton (verbatim — facts are pinned
   to it, so participants of the same event never hold contradictory facts) + that participant's
   own material (initial personality + current status ledger). Output = a 2–3 sentence
   second-person memory from his limited perspective: only what he could perceive, attitude and
   tone shaped by his own personality (the pleader's grateful memory and the begged person's
   reluctant-compliant memory are two legal renderings of one skeleton). Hard constraints: no
   adding/removing plot, no metaphor/foreshadowing/scene-setting/literary flourish/exaggeration.
   Failed renders are skipped individually.

Each rendered memory is injected into **its participant only** (`source = 离场经历`, no `mid`,
current round) — including participants who are not entrants (the person who was sent on the
errand remembers doing it even if he never entered the scene where it's discussed). Ledger rows
first (§5.4); every injection logged to 判定.jsonl with its full text (drift is auditable).
Everything runs in the background in parallel with the scene snapshot; `speakAs` waits for the
whole entry kit before an entrant speaks.

---

## 6. LLM protocols

Judgment (fast, synchronous) and bookkeeping (slow, background) are separated. Fallback chain:
fast path → full director (single call) → heuristic. No `routerId` = single full call only.

### 6.1a Fast path (`jevRoute`)

One `jevRoute` call (systemOne protocol; native typed questions `noul`/`choice`; no generated
text; transport failures throw and are caught). Questions:

- `next_speaker` (choice over the speakable roster; confidence < 0.45, an out-of-roster pick, or
  a missing answer → **only the route** falls back to the full director — `picked` is returned
  empty and every other judgment from the same call still applies; the failed attempt itself is
  always written to the judgment log with Jev's raw answers). Addressee determination weighs the
  parenthetical stage direction over names in the spoken text: "（看着X说道）" marks X as the
  addressee even when the speech names someone else (a name in speech may be a third person being
  *talked about*); when the parenthesis points at nobody, a direct name in speech wins. The main
  route **deliberately does
  not offer the user as a choice**: a user message always gets a character response. Handing the
  floor back to the user is the relay's job (below), where the context makes the choice honest.
- `present_<角色>` for every character (noul "is he in the scene right now"): ≥0.7 in, ≤0.3 out,
  in between = keep current state (no presence row). **Dialogue takes precedence over records**:
  the scene record and the status ledger can lag behind the story — when the dialogue depicts
  someone arriving, judge him present (updating the record is this judge's own job).
- `perceive_<角色>` / `interact_<角色>` for off-scene characters (abstract criteria, §4.1):
  derive remote (both high) / overhear (perceive high, interact low) / absent; ambiguous keeps the
  current layer; `mode_<角色>` (choice 语音/视听) sets the modality; existing notes and `since`
  are carried by `setScene`.
- `knows_<角色>` for every character (noul "can he perceive the content of this message"):
  ≥0.5 → knowledge audience (§4.3/§4.4).
- `told_<角色>` for every character (noul "is this message telling him something he does not
  know"): ≥0.5 → retelling trigger, stage 2 of §5.7; missing answer = not triggered.
- `state_dirty` (one noul, "could this message have any **persistent influence** on the
  characters — injuries, emotional shifts, moved positions, changed relationships, learning
  something important; pure small talk does not count"): ≥0.5, or a missing answer, opens the
  status gate (§6.1b). This is an "influence" judgment, not a physical-environment one — nothing
  is ever skipped for "the environment did not change": presence, knowledge, retelling, routing
  and the gate are all re-judged every turn and after every reply.

State passed to the judge assembles the full relevant context (candidates, scene notes, complete
status lines, the user utterance, recent history).

**Merged post-reply judgment (`jevAfterReply`).** One call after each character reply, before
that reply is appended, answers four things at once: the reply's knowledge audience
(`knows_<候选>`, same threshold as the user message), `state_dirty`, `told_<候选>` (§5.7), and the
relay choice (`next_speaker`, criteria = speakable roster + the user). The relay frames the
choice as **who outputs the next content**, not who "speaks": a character's output may be speech,
action, expression, or silence — the target of a plea/question/demand gets the turn even if he
stays silent (his silence *is* the response). Whole-call failure → the
audience falls back to the deterministic rule, the status gate counts as open, no retelling, the
turn ends (relay-failure semantics). This replaces separate audience and relay calls — one Jev
call per reply.

**Stage-2 retelling rounds (`jevExtraRounds`).** One call per triggered character (§5.7): per
missing round a `round_<N>` noul, ≥0.75 → transplant. Failure or no hit grants nothing.

**Relay.** From the merged judgment: a picked character → append route row and continue; the
user, low confidence (<0.45), an out-of-roster pick, or failure → turn ends. Uncertainty resolves
to the user (never steal the floor). **Relay cumulative decay (pure code, invisible to Jev):** the
judge's full probability distribution travels with the pick, and the engine applies a per-character
cumulative multiplier before re-picking the argmax. A character's multiplier starts at 1 with his
first output of the turn and is multiplied by `RELAY_DECAY` (default 0.8) at every subsequent relay
judgment — **speaking again never resets it** (the decay is cumulative across re-speeches: at 0.64
he speaks again, the next judgment is ×0, the one after that is 0.64×0.8). The judgment immediately
after a speech instead multiplies that speaker's probability by **0** — a character can never take
the floor twice in a row — and does not advance his multiplier. Characters who have not spoken this
turn and the user keep their raw probability (the user's weight never decays). There is **no hard
cap**: every speaker's multiplier decays geometrically while the user's does not, so the weighted
argmax eventually lands on the user and the chain ends by itself. The hard zero also holds when the
distribution is missing (or every candidate weights to 0) and Jev re-picks the just-spoke speaker:
the turn ends and the floor returns to the user — "no consecutive output" is an engine rule, not a
probability outcome. Flips and blocks are logged to 判定.jsonl (`接力加权`).

Thresholds (`JEV_THRESHOLDS`): `{ confidenceMin: 0.45, perceiveMin: 0.7, interactMin: 0.7,
interactMax: 0.3, gateKeep: 0.5, toldMin: 0.5, extraRoundMin: 0.75 }`.

### 6.1b Slow path (`askBookkeeper`)

`record_round` tool, queued in the background after the stream. Records: `状态账本`
(whole-snapshot seven-field updates, §3.4a) only. No memory fields, **no scene roster writes** —
the bookkeeper has no presence authority: it must not add or remove scene members, and any
`presence_updates` it emits anyway are discarded by the engine `[WHY]` roster authority belongs to
the judge and the correction surfaces, not to bookkeeping.
Position status still tracks movement inside the ledger. **Gated** (fast path): the work list
holds the user message and each reply whose judgment opened the status gate (missing answer =
open); one deepseek call per list entry — the user message can be its own entry with no reply
section, which also covers no-reply turns (e.g. the picked speaker has no speech rights). An
empty list means no bookkeeping call at all. The fallback path is unchanged: the full director's
ledger updates apply inline and no background bookkeeping runs. Failures are logged (`DSH_DEBUG`
and 判定.jsonl) and never fatal.

### 6.1c Fallback full director (`routeNextSpeaker`)

`route_and_remember` tool: routing + `状态账本` + `presence_updates` in one call; ledger updates
apply inline after the reply. This is the director's **compensatory takeover** — it runs only
when the Jev call itself failed (a salvage turn keeps Jev's own scene corrections and the
director's `presence_updates` are ignored by the pre-existing if/else split). Its scene-people
authority is **extremely strict, two rules**: a character absent from the roster joins only when
the dialogue explicitly depicts him entering/appearing/being called in; a character on the roster
leaves only when the dialogue explicitly depicts him unconscious or leaving — plausibility
("he lives here", "he could be nearby") never counts. No tool carries memory fields. Failure of
the director call or an out-of-roster pick → heuristic: mention detection on the pending user
text → even pick excluding the last speaker.

### 6.1d Scene summarizer (`askSceneSummarizer`)

`record_scene` tool; used only by §5.8. Observable-only constraints are part of the tool
description and the prompt; both must stay intact.

### 6.2 Character turn assembly (`assembleGroup`)

System sections in order (empty sections skipped): 你扮演「{name}」; appearance + background;
personality (initial; current deviation comes from the ledger's 性格演变 inside `ledgerPrompt`);
relationships (initial; dynamics likewise); status ledger (`ledgerPrompt`, §3.4a); scene section
(§4.1: present list, remote links with limits, self-declaration when the character is remote or
overhearing; **overhearers are never listed to scene members**; an appearance line exposing the
`角色.md` appearance of the other characters in the scene — appearance only, identity/background/
personality/status-ledger stay hidden `[WHY]` people in a conversation see each other's looks,
but physical changes are inferred from context rather than read from others' ledgers); user
persona; memory injection
(`buildMemory`, §5.5); era/world; the **map section** (`【场景】`: the active scene plus every
scene's full description — the world's places are fixed data, never guessed); rules; closing
instruction (`roleplayInstruction`: the output
is the character's reaction — usually with spoken lines, but pure action/expression/silence is a
legal output when the story demands it, since the relay can hand the turn to a character whose
response is silence; no speaking for others).

Message history: effective view filtered by `visible_to` (own character lines always visible),
last `CONTEXT_WINDOW` messages (default 36), character lines → assistant, everything else →
`name：text` user lines, adjacent same-role merged. No separate channel-feed block exists: linked/overhearing characters
see what their `visible_to` membership grants (§4.5).

Generation: single streaming call (`turnFromMessages`), system message prepended; empty message
list → no call (info 空回复). `stripNameEcho` removes a leading self-name echo.

### 6.3 Correction window

`POST /api/group/{name}/director` → `correct()`. Input: last ≤8 effective messages, roster lines,
scene notes, the user's text. Output applied in order: presence corrections → knowledge retracts
→ ledger snapshots → knowledge appends. `applied[]` summarizes what actually landed. Archived as
a `director` row; never enters any character input.

### 6.4 Director personnel notes

Present: `名` or `名（失聪+失明）`; linked: `名（通道接入·只有声音|声音和画面·{note}）`;
overhearing: `名（单向感知·只闻声|只见画面·{note}）`. This is the director's basis for judging who
perceived what; the overhear layer is director-and-player only.

---

## 7. HTTP API, CLI, frontend contract

### 7.1 Conversation (NDJSON streams)

| endpoint | note |
|---|---|
| `GET /api/groups` | group list |
| `GET /api/group/{name}` | snapshot: `{name, era, world, tone, scene, scenes[{name,description}], userName, present[], remote[], overhear[], absent[], characters[{name,dirName}], messages(effective view), routes}` |
| `GET /api/group/{name}/status` | per-character status-ledger lines + memory counts |
| `GET /api/group/{name}/judgments` | tail (last 200, newest first) of 判定.jsonl (§3.2a); for the sidebar run-log panel |
| `POST /api/group/{name}/message` | body `{text, scene?}` (scene = ⊘-picked target) → event stream (§1.1) |
| `POST /api/group/{name}/roll` | reroll last character message → event stream |
| client disconnect | the generator keeps running; bookkeeping still completes |

Events: `{type:"speaker",name}` / `{type:"route",picked,reason,fallback}` /
`{type:"delta",text}` / `{type:"reply",name,text,private}` / `{type:"ledger",text}` /
`{type:"info",text}`. `ledger` events occur only when bookkeeping applies inline (fallback path);
fast-path background bookkeeping is visible after refresh. Opening a group triggers the
stale-entry heal (§5.3).

### 7.2 Editor and maintenance

| endpoint | note |
|---|---|
| `POST /api/groups` | create group (name validated; generates empty 用户.md) |
| `PUT /api/group/{name}/settings` · `GET\|PUT /api/group/{name}/user` | group settings; user persona (sessions dropped on change) |
| `POST /api/group/{name}/character` · `GET\|PUT /api/group/{name}/character/{dir}` | create / read / update character initial definition (`:dir` validated by `isValidName`; update refuses duplicate names and writes a `rename` row) |
| `POST /api/group/{name}/message/{id}/edit` · `.../delete` | edit (physical rewrite + memory rewrite) / delete (physical removal + memory cleanup) |
| `GET\|POST /api/group/{name}/character/{dir}/memory` · `DELETE .../memory/{index}` | memory view / add (`用户指定`) / retract by index |
| `GET\|PUT /api/group/{name}/avatar` · `GET\|PUT /api/group/{name}/user/avatar` · `GET\|PUT /api/group/{name}/character/{dir}/avatar` | avatars — display-only, never sent to any model or director. PUT body = raw image bytes (JPEG/PNG/WebP/GIF, magic-byte checked, ≤2 MiB; the client downscales to a square JPEG before upload). GET → 404 = unset. Storage: `头像.dat` in the group dir (group avatar) / character dir (character avatar), `用户头像.dat` in the group dir (user persona avatar) |
| `GET\|PUT /api/group/{name}/character/{dir}/ledger` | status ledger read / whole-snapshot user update |
| `GET\|PUT /api/group/{name}/presence` | scene layers; `scene` = active scene (map groups); `remote`/`overhear` omitted = keep that layer; checked members' locations move to the active scene, unchecked keep theirs; manual fixes trigger the entry kit for new entrants |
| `GET\|POST /api/group/{name}/scenes` · `PUT .../scenes/{scene}` | scene map: list / create (name immutable once created, no delete) / edit description |
| `GET\|POST /api/group/{name}/director` | correction window history / speak |
| `GET\|PUT /api/rules` | global rules |
| `GET\|POST /api/models` · `PUT\|DELETE /api/models/{id}` · `POST /api/models/{id}/activate` · `PUT /api/models/router` | provider management; deleting the active provider falls back to the first; the router endpoint sets/clears the fast-path provider (deleting that provider clears it too) |

Errors: thrown → 400 `{"error"}`. Session cache `Map<群名, GroupSession>`; invalidated on group
settings/user/character/rules changes; status/memory/presence changes do not invalidate (the
engine re-reads disk every turn).

### 7.3 CLI

`pnpm chat:group <群名>`: commands `/cast` `/status` `/roll` `/quit`; input during a turn is
queued; `CLI_TURN_MARKER=1` prints `[[TURN_DONE]]` after each turn for automated drivers.

### 7.4 Group isolation [INV 5]

Sessions are per-group; routing rosters are per-group and normalized against the local roster;
all storage paths resolve inside the group directory.

### 7.5 Frontend redesign contract

The current frontend (`web/`) is a **minimal utility UI, deliberately undesigned**. A redesign
replaces the frontend only; the backend is a separate, already-specified surface.

**File map.**

- Changeable: everything under `web/` — `web/src/` (`App.tsx` shell + tabs, `chat.tsx` chat page,
  `groupinfo.tsx` chat-info pages, `ui.tsx` shared components, `api.ts` mirror types + fetch,
  `icons.tsx` inline Lucide SVGs, `tokens.css` design variables, `app.css` component styles),
  `web/src/main.tsx`, `web/index.html`, `web/vite.config.ts`, `web/package.json`, `web/tsconfig.json`.
  `web/dist/` is build output (gitignored; regenerate with `pnpm web:build`).
- Backend, **do not edit** from frontend work: everything under `src/` (`src/server.ts` defines
  the HTTP API; `src/group/*` the engine). If a UI feature needs a new endpoint or event, that is
  a backend change: update this SPEC (§7) first, implement in `src/`, then consume. Never patch
  `src/` as a side effect of styling.

**Mirror contracts to keep in sync** (frontend types duplicate backend types; a backend field
rename without the frontend twin breaks the UI silently):

- `Ev` union in App.tsx ↔ `SessionEvent` in `src/group/engine.ts`.
- `Snapshot` interface ↔ `engine.snapshot()` return shape.
- The `LEDGER_KEYS` constant duplicated at the bottom of App.tsx ↔ `LEDGER_KEYS` in
  `src/group/status.ts` (seven Chinese field names, exact order).
- Source labels (`亲历`, `额外得知`, `现场所见`, `用户指定`, `推断`, `他人告知`), presence layer
  names (`现场`/`接入`/`单向感知`), and perceive values (`语音`/`视听`) are displayed verbatim —
  never translate or alias them.

**Decisions to preserve across any redesign**:

- The chat column shows **only messages and streaming text**. Route/ledger/info events surface
  as a single transient status line above the input box (updated in place, never accumulated)
  plus the run-log panel. Do not reintroduce stacked note lines into the message flow.
- The run-log panel renders 判定.jsonl (§3.2a): rows are arbitrary JSON with a `phase` field —
  tolerate unknown fields, render the raw JSON on expand. It is humans-only diagnostics: never
  send any of it into a character/director request.
- The scene display lists **only characters currently and clearly 现场** (present checkboxes).
  `remote`/`overhear` stay in the snapshot/API and drive judgment, but are deliberately **not
  rendered** by the frontend (user decision, round-2 review). The `absent` field exists for
  compatibility and is also not rendered.
- Per-message edit/delete and reroll are physical operations; the delete confirm must keep
  saying the text is removed from the log.
- The models panel edits API keys only; providers are managed by editing settings.yaml.
  **Amendment (§12 self-contained build):** on the Android app the group data and
  `settings.yaml` live in app-private storage with **no external editor path**, so the panel
  becomes a two-section page: (1) **模型** — one custom dialogue provider, edited in place
  (API 密钥 / API 地址 / 模型 ID + a single 保存; creates the provider and activates it when
  none exists yet); (2) **总管快速判断（可选）** — a single key field: entering a key creates-or-
  updates the fixed Jev provider (`https://api.inferera.com`, `jev-latest`, effort `off`) and
  sets `routerId`; leaving it empty keeps the fast path off, so the engine falls back to the
  full director (the dialogue model) exactly as designed. 停用 clears `routerId`. The backend is
  unchanged; on the PC the panel keeps its historical key-only behaviour and the file remains
  the source of truth.
- **Route registration order:** literal segments must be registered **before** sibling `:param`
  routes (hono matches in registration order). `PUT /api/models/router` therefore sits above
  `PUT /api/models/:id`; swapping them silently turns the router endpoint into a 404
  ("提供方不存在").

**Ripple-sensitive spots.**

- `web/vite.config.ts`: dev proxy `/api` → `127.0.0.1:8787`; port `5173` with `strictPort`
  because `启动.bat` opens the browser at it and `停止.bat` kills by port. Changing ports means
  touching the two .bat files.
- Group/character names are Chinese and appear in API paths — always `encodeURIComponent` them.
- `POST /message` and `/roll` return NDJSON **streams**: read to stream end even on mid-stream
  errors (the server finishes the generator regardless of client disconnect); after the stream,
  re-fetch both the snapshot **and** `/judgments` (background bookkeeping and scene snapshots
  land after the stream closes).
- Session invalidation: settings/user/character/rules changes drop cached sessions; status,
  memory, and presence changes do not — the engine re-reads disk every turn. The UI's "re-fetch
  snapshot after any stream" rule depends on this; keep it.

---

## 8. Frontend (`web/src/`)

Mobile-first WeChat-style UI. React 18 + Vite, no component library, no runtime deps beyond
react/react-dom; plain CSS driven by `tokens.css` design variables (WeChat-derived palette:
page `#f7f7f7`, chat `#ededed`, cells white, brand `#07c160`, own bubbles `#95ec69`; light
theme only — deliberate). Desktop widths letterbox the app into a centered 520px column.

- **Shell** (`App.tsx`): three bottom tabs — 主页面 (group list: avatar / last-message preview /
  relative time, per-group snapshots fetched for previews; pull-less reload on mount; search
  filter; ＋ → new-group page) · **全局** (a two-entry hub: 全局规则 = 规则.md editor, save =
  PUT /api/rules; **正则替换** = display-layer rewrite rules, see below) · 模型配置 (custom
  dialogue provider + optional Jev key, per §7.5 amendment). View stack: chat, chat-info, new group.
  The **new-group page** builds the map at creation: scene rows (名称 + 描述, added/removed
  locally) with one checked as the 初始当前场景; creation POSTs `{name, era, world, tone, scenes, scene}`.
- **Display-layer regex** (`web/src/regex.ts`, user-requested): user-defined
  `pattern → replacement` rules applied **only when rendering** chat bubbles (messages and the
  streaming transcript), using the browser's native `RegExp` — no dependency, no model exposure.
  Rule text, memories, ledgers, judgments and everything the characters see stay verbatim; the
  message editor shows the raw text. Rules live in `localStorage` on the device, are validated
  before saving (invalid patterns rejected), support `$1` back-references, and an empty
  replacement deletes the match.
- **Chat** (`chat.tsx`): chat column shows messages + streaming text only (§7.5 decision); no
  timestamps are displayed. The composer's left button (⊘, circle-with-slash) opens a floating
  scene picker listing the group's scenes (current one marked); picking one arms the next send —
  the message POSTs with `scene`, the turn skips the scene-change judgment and lands the user in
  that scene; a cancel row disarms. User = green bubbles right with own avatar; characters = white
  bubbles left with avatar and name label. Long-press (450 ms; desktop right-click) opens an
  action sheet: 修改 / 删除 / 批量删除 (+ 重掷这条回复 on the last character message). 批量删除
  enters a select mode: checkboxes beside rows, tapping toggles, the composer is replaced by a
  取消 / 删除（N） bar, one confirm (text states the text is removed from the log) then the
  selected messages are deleted sequentially. **During a turn** the messages after the last
  snapshot come from a turn-local transcript (speaker appends, delta fills, reply marks done —
  relay chains 我>B>C render in order, nothing disappears or duplicates) plus the optimistic
  echo of the user's own message; the stream is read to end, then the snapshot refresh and the
  transcript/echo teardown land in the same render commit (§7.5) — no dead window, no
  full-list flash. On send failure the echo is removed immediately. route/ledger/info events
  surface as the single transient status line above the composer (updated in place; the judge
  waiting hint is not displayed). NDJSON stream read to end; snapshot re-fetched after the
  stream (§7.5). Auto-scroll pins to bottom only when the user is already at bottom.
- **Keyboard** (chat): no JS lift at all. The composer is a normal flow element pinned to the
  page bottom; keyboards that compress the layout viewport (the fleet's Android browsers) carry
  it above them naturally. A small visual-viewport listener only guards against whole-document
  panning (scroll back to 0) and re-pins the log bottom. Overlay-style keyboards that leave the
  layout viewport unchanged (e.g. iOS Safari) would cover the composer — accepted: the fleet is
  Android + desktop.
- **聊天信息** (`groupinfo.tsx`, the ⋯ button): avatar block (group avatar + member avatars +
  我) and seven pages — 群聊设定 · 我的设定 (user persona + user avatar) · 纠正窗口 (rendered
  as a chat: user green bubbles right, 总管 white bubbles left with name label, applied summary
  under the reply) · 此时明确现场者 (present checkboxes only — no remote/overhear display) ·
  **场景** (map page: create-scene form + list; tapping a scene edits its description in a modal —
  names are immutable and scenes cannot be deleted) ·
  角色 (list → character page = 个人资料 draft form + 记忆 panel + 状态账本 section) ·
  运行日志 (判定.jsonl tail, rows expandable to raw JSON).
  The **character form** carries 初始所在场景: a radio list over the group's scenes when creating
  (chosen once, immutable afterwards — the edit page shows it read-only), absent when the group
  has no scenes. Content editing happens in centered
  floating modals (`Modal`): the message action menu and message editor in the chat, and each
  状态账本 field in the character page (tap a field row → modal editor with its own 保存; the
  PUT carries only that field — the backend merges, omitted fields carry forward). Ledger
  values render as wrapped multi-line text (never single-line inputs). No helper/hint captions
  anywhere (user decision: gray explanatory small text is omitted).
- **Avatars** (§7.2 endpoints, display-only): upload = client-side center-crop to a 320 px
  square JPEG (`canvas`), PUT raw bytes; unset → 404 → fallback avatar (first character of the
  name on a hashed palette color). Avatars never enter any model or director input.

---

## 9. rebuild (`pnpm rebuild <群名>`, `scripts/rebuild.ts`)

Replays ledger rows per character (names resolved through the name chain):

| artifact | semantics |
|---|---|
| 状态.yaml | replay of status snapshot rows (fixed seven fields); if a character has no snapshot row at all, keep the seeded on-disk ledger |
| 记忆.jsonl | pure replay; on-disk entries missing from the replay are appended as ledger rows (repair) |
| 性格.md / 人物关系.md | user initial content protected from disk; no dynamic sections exist |
| 角色.md | never touched |
| 在场.yaml | replay of the last presence row, names chained, filtered to existing characters |

---

## 10. Test matrix

Convention [INV 11]: fixtures are temporary and always deleted. Offline checks need no API key.

| script | kind | pins |
|---|---|---|
| `selfcheck:llm` | online | channel/model/thinking params/stream parsing/tool-call fallback |
| `selfcheck:m1` | offline | file loading/injection · heuristic routing · name normalization · assembly |
| `selfcheck:m2` | offline | ledger determinism/idempotence · snapshot semantics · ledger normalization · memory retracts · 角色.md immutability · physical edit/delete/reroll (log = current snapshot, id never reused) |
| `selfcheck:m3` | offline | visibility filtering · transplant idempotence (verbatim entries) · injection budget · message window = CONTEXT_WINDOW |
| `selfcheck:scaffold` | offline | group/character creation products load · updates keep user content · name validation · empty rules inject nothing |
| `selfcheck:settings` | offline | rules zero-built-in round-trip · provider parsing/fallback · router provider resolution |
| `selfcheck:presence` | offline | three-layer yaml round-trip (with `since`) · parse semantics (omitted=keep/empty=clear/unknown=语音) · perception keywords · visible_to snapshots |
| `selfcheck:engine` | offline | bad-line tolerance + id continuity · text-retract no-resurrection (restart/replay) · edit living-ledger (physical ledger-row rewrite, respects retracts) · deleted-message physical removal (no text left in log) + memory cleanup + id monotonicity · rename chains |
| `selfcheck:router` | offline | Jev hit / three-layer derivation / knowledge audience (incl. overhearers) / `told` stage-1 + `state_dirty` parsing (missing = safe side) · low-confidence, out-of-roster → route-only fallback with raw answers logged · scene/knowledge salvage when route unusable · `jevExtraRounds` stage-2 thresholds / failure grants nothing · `missingRounds`/`transplantRounds` units (verbatim, mid, own-speech prefix) · end-to-end merged judgment (1 call/reply) · extra-memory grant (end-append order, ledger rows, idempotence on re-telling) · gate (zero deepseek calls when clean, exactly one when dirty) · bookkeeper has no roster authority (overreach discarded) · scene-perception snapshot (entrant detection, injection before entrant speaks via relay, manual-fix entries snapshotted too) · off-story experiences (absence anchor pure-code, discovery merged per entry, event×participant limited-POV renders injected to all participants, first-time entrants skipped) · judgment log (判定.jsonl rows with phases + raw answers + elapsed) · relay (user turn / cumulative decay: ×0 right after a speech — no consecutive output, that judgment does not advance the multiplier; `RELAY_DECAY` applied at every other judgment, cumulative across re-speeches; no hard cap, the undecaying user weight ends the chain; hard block hands the floor back to the user on just-spoke re-picks and all-zero distributions) · fallback = single full director · unconfigured = fast path off |
| `selfcheck:scene` | offline | scene file layer (create / duplicate reject / description editable / name immutable / invalid name) · group creation builds the map + initial scene · character 初始场景 placement · ⊘ manual move skips scene_change (questions assert) and still moves · destination occupants present by record and hear the arrival line · followers placed, leavers fall to their location answer (其他 clears) · judged move (confidence-guarded) · strict no-move · dialogue entrant lands post-snapshot (not in visible_to) with the entry kit injected · colocated-by-record characters are not entry-kit targets · map full text + active scene injected into characters |
| `acceptance-*` (m1–m5, isolation, models, context-edit, presence, director) | online | end-to-end behaviors per milestone; re-run after any fast-path or memory change |

`DSH_DEBUG=1` prints director/judge failure causes.

---

## 11. Known limitations (accepted, with mitigations)

| limitation | mitigation |
|---|---|
| thinking mode ignores `temperature` → reroll variance shrinks | accepted; use a low-thinking model for more variance |
| slow-path deepseek thinking takes seconds; timeout degrades routing | fast path routes in ~1s; three-level fallback chain; `DIRECTOR_TIMEOUT_MS` |
| models hallucinate "memories" | memory is verbatim-transplanted (nothing to invent); ledger + correction window bound the damage |
| streamed replies may echo the speaker name prefix | `stripNameEcho` strips it engine-side |
| sound-only links may receive visual text | judged by the fast path per message; residual error is bounded by director bookkeeping and the correction window |
| two sequential LLM calls per turn (judge → character) | judge ≈1s; bookkeeping runs in the background after the reply |
| fast-path probability jitter (routing/scene/knowledge) | conservative thresholds (ambiguity = keep/return to user); scene/knowledge judgments survive route failures; correction window fixes wrong calls; `JEV_TIMEOUT_MS` |
| reply knowledge judgment delays the `reply` event by one sub-second call | brief cursor linger; failure keeps the keyword rule (no added risk) |
| background bookkeeping finishes after the stream closes | its ledger notes are not streamed; files are authoritative and visible on refresh |
| relay chains can burn tokens | no hard cap by design: ×0 forbids immediate repeats, each speaker's cumulative multiplier decays `RELAY_DECAY` per judgment (re-speaking never resets it) while the user's never decays; chains end on the user pick, low confidence, relay failure, or an empty reply; background bookkeeping does not block |
| user edits/deletes/rerolls physically rewrite 剧情.jsonl — the original wording is unrecoverable | accepted by design: the log is the current context snapshot (user decision); 状态.yaml / 记忆.jsonl keep their own accounting, and archived dialogs (director rows) are untouched |
| a retelling grant assumes the narration is truthful — a lie grants the true rounds | accepted: verbatim-transplant philosophy; correction window / memory panel can retract |
| the status gate is one Jev judgment; a false "clean" skips deepseek bookkeeping for that message | missing answer = gate opens; fallback path unaffected (inline bookkeeping); the correction window can still write ledgers |

---

## 12. Android self-contained app (`android/`, additive)

The whole stack — engine, HTTP host, frontend — also runs **on the phone**, with no PC involved.
Nothing in `src/group/*` changes: the app runs the same bundled `server.ts` against an app-private
data root.

**Layout (payload → app-private storage).** The bundle derives everything from
`config.root = parent(dirname(server.mjs))` (§2/§3.1 untouched), so `payload.zip` extracts to:

```
filesDir/app/server.mjs      bundled backend (single ESM file, esbuild)
filesDir/dist/**             frontend build (served by registerStatic)
filesDir/groups/**           user data — never inside payload.zip, upgrades never touch it
filesDir/settings.yaml       created when the user saves a key in 模型配置
filesDir/规则.md              optional, user-authored
```

**Process model (`android/app/src/main/java/...`).**

- Splash: the theme's `windowBackground` is brand green and the shell shows a full-screen green
  view with the logo — the bubble plus three dots bouncing in sequence (native
  `AnimatedVectorDrawable`, no dependency) — held for a 900 ms minimum, then cross-faded (220 ms)
  into the WebView. Status-bar icons are white on the splash, dark on the UI.
- `MainActivity` — the only activity; consumes window insets manually (`targetSdk 36` forces
  edge-to-edge): top = status bar, bottom = `max(ime, navigationBar)`. The WebView view is
  therefore compressed to the keyboard's top edge and the frontend's flow-composer sits flush
  against it (no browser chrome, no gap). Back key = `moveTaskToBack` (the app's navigation is a
  React state stack, not URL history, so there is nothing to `goBack` to). `onShowFileChooser`
  bridges `<input type=file>` for avatar upload.
- `NodeRunner` — spawns the bundled Node runtime as a **child process of the app process**,
  started by `MainActivity.onCreate` and stopped in `onDestroy`. No foreground service and
  therefore **no persistent notification** (user decision: the local server's only client is
  this app's own WebView, so keep-alive bought nothing and the notification was pure noise).
  Payload extraction runs on the startup thread; Node executes from `nativeLibraryDir` (Android
  10+ forbids executing files in app data) and logs to `filesDir/app/server.log`. Trade-off: the
  server lives and dies with the app process (reopening restarts it in ~1 s), and the manifest
  therefore needs only `INTERNET`.
- `Payload` — payload extraction with path-traversal guard and `\` → `/` entry-name
  normalization (Windows-built zips use backslashes; Linux would treat them as literal
  characters).

**Runtime packaging (`runtime-node/`, `scripts/`).** The Node runtime is a Termux-derived
aarch64 build; Android's installer only unpacks files named `lib*.so`, so `stage-node-android.mjs`
renames the versioned libraries and rewrites the `DT_NEEDED`/`DT_SONAME` strings in place
(NUL-padded, same length), then verifies the dependency closure by parsing each shipped ELF and
checking 16 KB page alignment. `build-android.mjs` builds the frontend, bundles the backend and
zips the payload with `tar -a` (forward-slash entry names).

**Server-side additions (§2/§7).** `server.ts` gains two additive lines and one environment
gate: `registerStatic(app)` (only active when `ROOT/dist` exists; unknown GETs fall back to
`index.html`) and `hostname: process.env.HOST_BIND` (`unset` = historical behaviour; the app sets
`127.0.0.1` so the server is not exposed to the LAN).

**Known limitations.** The APK ships `arm64-v8a` only; `minSdk 30`; the back key backgrounds the
app instead of navigating within it; the Node runtime accounts for nearly all of the APK's ~39 MB.
