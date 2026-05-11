# Plan — unified interactive chat across zeroclaw / openclaw / hermes

Status: **design only — implement later.**

This document captures the protocol surfaces each supported agent
exposes for *interactive* chat (streaming tokens, tool calls, approval
prompts), and proposes a single abstraction the companion can drive.
The current `/webhook`-only path stays as a fallback when interactive
is off or unsupported.

---

## 1. What we have today

```
companion ── POST /webhook {"message"} ─▶ agent
companion ◀── {"response"} ──────────────  agent
```

Single-shot. Agent's full reply comes back as one string. Tool calls
happen invisibly inside the agent loop; if a tool needs operator
consent, zeroclaw's `ApprovalManager::for_non_interactive` auto-denies
because there's no return channel. Same fallback for openclaw's
`/v1/chat/completions` and for hermes via the `hermes-bridge.py` shim.

Net effect: the user never sees `tool_call`, `tool_result`, or
`approval_request` events. Long agent runs sit silent for 30 s before
the final answer lands.

## 2. What each agent exposes for interactive chat

### 2.1 zeroclaw — `GET /ws/chat?session_id=…`

Native WebSocket on the same gateway. Documented in
`crates/zeroclaw-gateway/src/ws.rs` (upstream). Frames:

```
S→C  {"type":"session_start", "session_id":"…", "name":"…", "resumed":true, "message_count":N}
C→S  {"type":"message", "content":"…"}
S→C  {"type":"chunk", "content":"…"}
S→C  {"type":"tool_call",   "id":"…", "name":"shell", "args":{…}}
S→C  {"type":"tool_result", "id":"…", "name":"shell", "output":"…"}
S→C  {"type":"approval_request",
        "request_id":"<uuid>",
        "tool":"shell",
        "arguments_summary":"command: git status",
        "timeout_secs":120}
C→S  {"type":"approval_response",
        "request_id":"<uuid>",
        "decision":"approve" | "deny" | "always"}
S→C  {"type":"done", "full_response":"…"}
```

`arguments_summary` is render-only; the runtime strips `#[secret]`
fields before synthesising it, so we can show it verbatim.

### 2.2 openclaw — primary surface is **ACP** (Agent Client Protocol)

`openclaw acp` runs an ACP bridge backed by the WebSocket Gateway:

```
openclaw acp --url ws://host:18790 --token <pair_token>
```

Speaks JSON-RPC 2.0 over **stdio** when run as a subprocess by an
editor, or **the bridge can be pointed at a remote gateway WS**
(`--url`). ACP is a published spec from the team that makes Zed; the
relevant methods for us:

```
client→server  initialize
client→server  session/new
client→server  session/prompt   { sessionId, prompt }
server→client  session/update   { sessionId, update: { sessionUpdate, … } }
                  sessionUpdate ∈ {
                    "agent_message_chunk",
                    "agent_thought_chunk",
                    "tool_call",
                    "tool_call_update",
                    "plan", … }
server→client  session/request_permission
                  { sessionId, options: [
                      {"optionId":"allow-once","kind":"allow_once","name":"Allow once"},
                      {"optionId":"allow-always","kind":"allow_always","name":"Always allow"},
                      {"optionId":"reject-once","kind":"reject_once","name":"Reject once"},
                      {"optionId":"reject-always","kind":"reject_always","name":"Always reject"} ],
                    toolCall: { … } }
client←─reply─  outcome: "selected", optionId: "…"
                          | "cancelled"
```

Plus `fs/read_text_file`, `fs/write_text_file`, `terminal/create` —
client-provided capabilities the agent calls back into.

A non-interactive OpenAI-compatible `POST /v1/chat/completions` is
available too (we use that today via the `Openclaw` kind), but it
doesn't surface tool calls or approval prompts.

### 2.3 hermes — `hermes acp` is the cleanest interactive surface

Same ACP family. From `hermes acp --help`:

> "Start Hermes Agent in ACP mode for editor integration (VS Code,
> Zed, JetBrains)."

Spawned as a subprocess with stdio JSON-RPC. The `hermes dashboard
--tui` path also embeds a chat tab over a PTY/WS, but that's a UI,
not a programmatic protocol. The current `hermes-bridge.py` shim is
fire-and-forget HTTP.

### 2.4 Summary

| Agent    | Primary interactive surface | Approval prompt? | Tool stream? |
|----------|------------------------------|------------------|--------------|
| zeroclaw | `GET /ws/chat` (native WS)   | `approval_request` frame | `tool_call` / `tool_result` |
| openclaw | `openclaw acp` (stdio or WS) | `session/request_permission` (ACP) | `session/update.tool_call` |
| hermes   | `hermes acp` (stdio)         | `session/request_permission` (ACP) | `session/update.tool_call` |
| custom   | n/a                          | n/a              | n/a |

**zeroclaw is the odd one out** — it has a bespoke WS protocol. The
other two share the published ACP spec.

## 3. Unification target

Drive **all three through ACP** when interactive mode is on:

- openclaw / hermes — already speak ACP. Subprocess (`<agent> acp`) +
  pipe stdio, or for openclaw point ACP at the remote gateway WS via
  `openclaw acp --url ws://host:18790`.
- zeroclaw — its `/ws/chat` protocol is *almost* a one-to-one mapping
  of ACP's relevant subset. Either:
  1. Use zeroclaw's `/ws/chat` directly and translate frames into
     our internal "interactive chat" event type, OR
  2. Spawn `zeroclaw acp` (zeroclaw has an `acp_channel.rs` —
     verify it ships as a CLI). If yes, life gets even simpler.

ACP wins because it's a stable, published, multi-implementation spec.
Going down to one client adapter for all three is the long-term
maintenance payoff.

## 4. Internal event model

A single Rust enum the companion uses for the in-process event bus,
agnostic of which underlying adapter produced it:

```rust
pub enum ChatEvent {
    /// Streaming reply token. Append to current turn's bubble.
    Chunk { content: String },
    /// Agent is thinking out loud (chain-of-thought). Render in a
    /// collapsible "thinking" subsection of the bubble or omit.
    Thought { content: String },
    /// Agent about to run a tool. Show an inline pill in the chat.
    ToolCall { id: String, name: String, summary: String },
    /// Tool finished. Update the pill with output (or error).
    ToolResult { id: String, output: Option<String>, error: Option<String> },
    /// Agent asks the user to approve before running a privileged
    /// tool. Renders as a card with Allow / Allow Always / Deny /
    /// Deny Always buttons. The companion replies via ApprovalAnswer.
    ApprovalRequest {
        request_id: String,
        tool: String,
        summary: String,
        timeout_secs: u64,
    },
    /// Final assistant message, full text. Triggers TTS via the
    /// existing avatar pipeline.
    Done { full_text: String },
    /// Adapter-level error (disconnect, parse, etc.).
    Error { message: String },
}

pub enum ChatCommand {
    Send { content: String },
    ApprovalAnswer {
        request_id: String,
        decision: ApprovalDecision,
    },
    Cancel,
}

pub enum ApprovalDecision { Allow, AllowAlways, Deny, DenyAlways }
```

## 5. Adapter surface

```rust
#[async_trait]
pub trait InteractiveAgent: Send + Sync {
    /// Open a session with the agent. Returns a stream of ChatEvents
    /// and a sender for outgoing ChatCommands. The implementation is
    /// responsible for reconnect / process-respawn on transport
    /// failure; the companion just sees `ChatEvent::Error` for
    /// unrecoverable cases.
    async fn open_session(&self, label: &str)
        -> Result<(BoxStream<ChatEvent>, mpsc::Sender<ChatCommand>)>;
}
```

Three impls live under `crates/companion-core/src/agent/`:

- `ZeroclawWsAgent` — connects to `/ws/chat`, parses the bespoke
  frame shape, normalises into `ChatEvent`. Outgoing translates
  `Send` → `{"type":"message"}` and `ApprovalAnswer` →
  `{"type":"approval_response"}`.

- `AcpStdioAgent` — spawns `<binary> acp` with piped stdio, frames
  JSON-RPC 2.0, sends `initialize` + `session/new` + `session/prompt`,
  receives `session/update` and `session/request_permission`,
  normalises into `ChatEvent`. Used for openclaw and hermes.

- `AcpRemoteAgent` (optional, deferred) — `openclaw acp --url`
  variant that targets a remote gateway WS instead of the local
  process. Same event shape, different transport. Convenient when
  the agent runs on the Pi.

The non-interactive path stays as `WebhookAgent` /
`OpenAICompatAgent` (today's `ZeroclawClient`) for users who want the
simple "no surprises" mode.

## 6. Wire-up in the companion

### 6.1 Server side

- **`AvatarWsState`** gains an optional `InteractiveAgent` handle the
  HTTP `/api/chat` route uses. The current bulk path returns the full
  reply as today (no UI change for non-interactive users); the
  interactive path forwards each `ChatEvent` to the existing
  `event_tx: broadcast::Sender<AvatarEvent>` so all WS-avatar
  consumers (main window + overlay) see the same stream.

- **New `AvatarNotification` variants** (the wire shape between
  server and frontend over `/ws/avatar`):

  ```
  TextChunk     { content }
  ToolCall      { id, name, summary }
  ToolResult    { id, output, error }
  ApprovalRequest { request_id, tool, summary, timeout_secs }
  Done          { full_text }
  ```

  These are additive — no existing variant changes.

- **New `AvatarMessage::ApprovalResponse`** so the frontend can send
  the user's Allow / Deny decision back. The server routes it into
  the active `InteractiveAgent` session's `ChatCommand::ApprovalAnswer`.

### 6.2 Frontend side

- **Chat bubble** gains three new node types: tool-call pill,
  tool-result inline panel, and an approval card. The approval card
  has four buttons mapped to the four `ApprovalDecision`s. Clicking
  any closes the card and sends the response.

- **Streaming render** — the assistant bubble grows as `TextChunk`
  events arrive, swapping to the full text at `Done`. The existing
  `process_speak` pipeline still fires on `Done.full_text` so TTS
  speaks the whole reply (we don't speak partial chunks — they'd
  fragment audio).

- **Settings → Main agent** gains an "Interactive (streaming + tool
  approvals)" toggle. Default on for zeroclaw + openclaw + hermes;
  off forces the legacy `/webhook` path. Disabled for `custom` until
  the user knows their endpoint supports it.

## 7. Open questions to settle during implementation

1. **Does zeroclaw publish an `acp` CLI?** `crates/zeroclaw-channels/
   src/acp_channel.rs` exists in upstream but it's a Channel impl,
   not a top-level command. If yes, we can drop `ZeroclawWsAgent`
   entirely and let zeroclaw go through `AcpStdioAgent` too.

2. **Where does the persona prompt go in the ACP flow?** Today we
   prepend the active character's `system_prompt` to the user message
   before POSTing /webhook (see `compose_persona_prefix`). The ACP
   `session/new` call accepts initial system context — we should
   move the persona prefix there, once per session, instead of
   prepending to every turn.

3. **Tool-call summary vs. tool-call args.** ACP's `tool_call.update`
   carries structured args (e.g. `{path, content}` for a file write).
   Zeroclaw's WS surface gives us only `arguments_summary` (a
   stripped, human-readable line). The internal `ChatEvent::ToolCall`
   should accept both — adapter passes through whatever it has,
   frontend prefers structured args but falls back to summary.

4. **Reconnect strategy.** ACP-stdio dies when the process dies;
   `ZeroclawWsAgent` lives behind a possibly-flaky WS connection.
   Both need reconnect with backoff. Decision: cap at 3 attempts in
   30 s, then surface `ChatEvent::Error` so the user can hit "Reconnect"
   manually.

5. **Persistence of session state across hot-swap.** Agent hot-swap
   currently builds a fresh `ZeroclawClient`. With sessions, hot-
   swap needs to either tear down the active session cleanly or
   migrate to the new agent on the same session id. Probably the
   former — session ids aren't portable across agent kinds.

6. **Approval policy persistence.** "Allow Always" decisions should
   stick to the conversation session for zeroclaw (handled
   server-side), but for openclaw/hermes ACP we'd be the only
   surface seeing the decision — do we need to mirror an
   `always-allowed` set client-side and skip future prompts for
   those tools? Or trust the agent to remember?

## 8. Estimated effort

- Adapter trait + ZeroclawWsAgent: ~half a day.
- AcpStdioAgent (JSON-RPC framing + `session/*` handling): ~1 day.
- `AvatarNotification` additions + chat-bubble pills + approval card:
  ~1 day, more if we want polished animations.
- Wire-up + Settings toggle + reconnect + e2e CDP test: ~half a day.

Total ~3 days of focused work, plus debugging real conversations.
This is meaningful enough that it should be its own commit series
with task tracking, not bundled into something else.

## 9. Sequencing

When we come back to this, suggested order:

1. Build `ZeroclawWsAgent` first against the running Pi zeroclaw.
   Smallest, no subprocess management. Validates the `ChatEvent`
   model end-to-end with one real agent.
2. Add the new `AvatarNotification` variants and frontend chat-
   bubble pills + approval card. Wire approval-response WS message
   back through. Verify with a `git status` request that triggers a
   real approval prompt.
3. Add `AcpStdioAgent` and switch openclaw + hermes to it via the
   adapter selection in Settings. Decide along the way whether to
   move zeroclaw onto ACP too (depends on Q1 above).
4. Settings: agent-kind dropdown gains the "Interactive" toggle.
5. Polish: reconnect, persona-via-session, hot-swap during an active
   session.
