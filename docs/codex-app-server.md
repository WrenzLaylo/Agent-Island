# Codex app-server, and why it does not replace scraping here

Task #21 was "move to structured interfaces and retire terminal scraping",
with `codex app-server` as the clear win for Codex. It is not, on this
platform, for the sessions Agent Island actually watches. This records why, so
the investigation is not repeated.

Everything below is from the vendored source at `.codex-source-0.146.1/`, not
from documentation or inference.

## What app-server is

`codex app-server` is the interface behind the Codex VS Code extension:
bidirectional JSON-RPC 2.0 over newline-delimited JSON on stdio, with the
`"jsonrpc":"2.0"` header omitted on the wire.

Approvals arrive as **server-initiated requests**:

| Request | Response |
|---|---|
| `item/commandExecution/requestApproval` | `{ "decision": … }` |
| `item/fileChange/requestApproval` | `{ "decision": … }` |

`ExecCommandApprovalParams` carries `command` as an **array of tokens**, plus
`cwd`, `reason`, `parsedCmd`, `callId` and `conversationId`. No parsing, no
box-drawing characters, no ambiguity about where a wrapped label ends.

## The decision vocabulary

From `ReviewDecision` in `app-server-protocol`:

```
"approved" | "approved_for_session" | "abort" | "timed_out"
| { approved_execpolicy_amendment: { proposed_execpolicy_amendment: string[] } }
| { denied: { rejection: string } }
```

Two things worth keeping even though we cannot use the transport:

- **`denied` and `abort` are different decisions.** The TUI does not offer a
  plain deny at all — its refusal row is "No, and tell Codex what to do
  differently", which is `cancel`/`abort` and ends the turn. This confirms
  from source what #20 fixed from behaviour: there is no keystroke in the TUI
  that refuses one command without killing the turn.
- **`approved_execpolicy_amendment` is what "don't ask again" really means** —
  a prefix rule added to execpolicy, which is why the island shows the exact
  prefix rather than the words "allow permanently".

## Why it cannot watch the user's session

Agent Island does not own agent processes. A user runs `island codex` in their
own terminal, which runs the real Codex TUI. app-server is for clients that
**own** the conversation, so nothing in it observes a TUI session someone else
started.

The control-plane transport that might have bridged the two is unavailable
here on two counts:

1. The unix-socket listener is `#[cfg(unix)]` in `app-server/src/lib.rs`.
2. `app-server-daemon/README.md` states plainly: *"The current daemon
   implementation is Unix-only … does not yet support Windows lifecycle
   management."*

Agent Island is a Windows overlay. Neither applies.

## What would actually be needed

Adopting app-server means Agent Island **hosts its own Codex conversation**
rather than overlaying the user's terminal one. That is a different product:
the island becomes a Codex client, and `island codex` stops being the entry
point. It is a legitimate direction, but it is a new feature rather than a
migration, and it does nothing for the terminal sessions the island exists to
watch.

## What was taken from this instead

`tui/src/bottom_pane/approval_overlay.rs` is the code that renders the panel we
scrape, so it is the authoritative list of labels Codex can print. All 17 are
now pinned in `tests/unit/codex-labels.test.ts`, which closed two gaps:

- `Yes, grant for this turn with strict auto review`
- `Yes, provide the requested info`

Both had gone unclassified. Unclassified is safe — the row renders verbatim and
is answered by its own digit — but it meant no scope confirmation and no risk
gating on rows that carry a real scope.

A capture only ever shows the panels that happened to appear while someone was
watching. The source shows the whole set.

---

## Superseded for approvals

Codex has a **hooks system**, which this document missed. `codex-rs/hooks/`
defines a `PermissionRequest` event that "runs in the approval path, before
guardian or user approval UI is shown" and whose handlers "can return a
concrete allow/deny decision, or decline to decide".

That is the structured interface #21 was looking for, and it does what
app-server could not: it reaches a session Agent Island does not own,
including the VS Code extension, because both run the same binary and read the
same `hooks.json`.

The conclusion above still holds for its own subject — app-server cannot
observe someone else's session, and its daemon is Unix-only. It was simply the
wrong place to look.

Implemented in `src/hooks/codex-hook.ts`; the vocabulary here is still the
authoritative reference for what Codex's decisions mean.
