# Codex CLI 0.146.1 approval UI contract

This document records the approval UI and input behavior of the installed `@openai/codex` 0.146.1 release for Agent Island.

Sources:

- Installed package: `@openai/codex` version `0.146.1`
- Official source tag: [`rust-v0.146.1`](https://github.com/openai/codex/tree/rust-v0.146.1)
- [Approval overlay implementation](https://github.com/openai/codex/blob/rust-v0.146.1/codex-rs/tui/src/bottom_pane/approval_overlay.rs)
- [Default keymap](https://github.com/openai/codex/blob/rust-v0.146.1/codex-rs/tui/src/keymap.rs)
- [List selection input handling](https://github.com/openai/codex/blob/rust-v0.146.1/codex-rs/tui/src/bottom_pane/list_selection_view.rs)
- [Approval session handlers](https://github.com/openai/codex/blob/rust-v0.146.1/codex-rs/core/src/session/handlers.rs)
- [App-server protocol](https://github.com/openai/codex/blob/rust-v0.146.1/codex-rs/app-server/README.md)

## Critical finding

**Agent Island must not map an ordinary Deny button to `Esc`.**

For command and file-edit approvals, Codex 0.146.1 maps `Esc` to `Cancel`, converts that to `ReviewDecision::Abort`, and calls `interrupt_task()`. It therefore aborts the whole active Codex turn rather than merely refusing one command.

The standard label:

```text
No, and tell Codex what to do differently
```

is a cancel/abort-turn action. It should not be presented as a non-aborting Deny action.

A real non-aborting denial, when Codex offers it, is:

```text
No, continue without running it (d)
```

Standard command prompts commonly do not offer that decision.

## 1. Exact blocking prompts

The following blocks are normalized terminal screen contents. ANSI styling, cursor-control sequences, unrelated screen rows, and right-padding to the terminal width are omitted. Codex uses a screen-redrawing TUI rather than printing one immutable text block.

There are **no box-drawing borders** around these approval prompts.

### Command approval

With a reason and persistent command-prefix option:

```text
  Would you like to run the following command?

  Reason: this is a test reason such as one that would be produced by the model

  $ echo hello world

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `echo hello world` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

Without a reason:

```text
  Would you like to run the following command?

  $ echo hello world

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with `echo hello world` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

When Codex cannot offer a safe single-line persistent prefix:

```text
  Would you like to run the following command?

  $ python - <<'PY'
  print('hello')
  PY

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

### File-edit approval

```text
  Would you like to make the following edits?

  Reason: The model wants to apply changes

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

The actual file diff may be rendered separately or in the fullscreen approval view. Diff lines are not additional decision rows.

### Network approval

```text
  Do you want to approve network access to "example.com"?

  Reason: network request blocked


› 1. Yes, just this once (y)
  2. Yes, and allow this host for this conversation (a)
  3. Yes, and allow this host in the future (p)
  4. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

The network prompt does not show a shell command. It identifies the destination host instead.

### Command requesting additional permissions

```text
  Would you like to run the following command?

  Reason: need filesystem access

  Permission rule: network; read `/tmp/readme.txt`; write `/tmp/out.txt`

  $ cat /tmp/readme.txt

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel
```

### Standalone permission request

```text
  Would you like to grant these permissions?

  Reason: need workspace access

  Permission rule: network; read `/tmp/readme.txt`; write `/tmp/out.txt`

› 1. Yes, grant these permissions for this turn (y)
  2. Yes, grant for this turn with strict auto review (r)
  3. Yes, grant these permissions for this session (a)
  4. No, continue without permissions (d)

  Press enter to confirm or esc to cancel
```

### Approval originating in another agent thread

```text
  Would you like to run the following command?

  Thread: Robie [explorer]

  $ echo hi

› 1. Yes, proceed (y)
  2. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel or o to open thread
```

### Legacy MCP elicitation

```text
  test-server needs your approval.

  Server: test-server

  Need more information

› 1. Yes, provide the requested info (y)
  2. No, but continue without it (n)
  3. Cancel this request (esc)

  Press enter to confirm or esc to cancel
```

### App/MCP tool-call approval

App tool calls can use a separate request-user-input or MCP form UI. Source-defined labels include:

```text
Allow
Allow for this session
Allow and don't ask me again
Cancel
```

Their descriptions are:

```text
Run the tool and continue.
Run the tool and remember this choice for this session.
Run the tool and remember this choice for future tool calls.
Cancel this tool call.
```

Depending on the elicitation form, the footer can be:

```text
enter to submit | esc to cancel
```

Ordinary model questions instead use text such as:

```text
enter to submit answer | esc to interrupt
```

The app/MCP form family must not be parsed as a normal command approval solely because it contains numbered rows.

### Width and risk variants

Width does not change the underlying decision labels. It changes layout only:

- Long reasons, commands, and option labels wrap.
- Continuation lines are indented.
- At sufficiently narrow widths, titles or single-line footers may be clipped.
- Terminal rows are padded to the current terminal width.
- No alternative high-risk title was found. Variants are based on request type, available decisions, and request data—not a generic risk-level string.

## 2. Exact option labels and row format

Rows use dotted numbers:

```text
1.
2.
3.
```

They do not use bracketed numbers such as `[1]`.

The selected row begins with U+203A, `›`:

```text
› 1. selected option
  2. unselected option
```

Option 1 is initially selected.

### Command labels

The complete set supported by the 0.146.1 approval overlay is:

```text
Yes, proceed
Yes, just this once
Yes, and don't ask again for commands that start with `<prefix>`
Yes, and don't ask again for this command in this session
Yes, and allow these permissions for this session
Yes, and allow this host for this conversation
Yes, and allow this host in the future
No, continue without running it
No, and block this host in the future
No, and tell Codex what to do differently
```

Not every request offers every label. The rows are constructed from the request's ordered `availableDecisions`.

### File-edit labels

```text
Yes, proceed
Yes, and don't ask again for these files
No, and tell Codex what to do differently
```

### Permission labels

```text
Yes, grant these permissions for this turn
Yes, grant for this turn with strict auto review
Yes, grant these permissions for this session
No, continue without permissions
```

### Legacy MCP elicitation labels

```text
Yes, provide the requested info
No, but continue without it
Cancel this request
```

## 3. Correct keystrokes

### Default mappings

| Input | Codex 0.146.1 behavior |
|---|---|
| `Enter` | Submits the highlighted option. Option 1 begins highlighted. |
| `1`–`9` | Selects and submits that numbered option immediately. |
| `y` | One-time approval. |
| `a` | Session/conversation approval; also used for the edit-files session choice. |
| `p` | Persistent command-prefix or future-host approval. |
| `r` | Grants requested permissions for the turn with strict auto review. |
| `d` | A genuine deny/continue action when that decision is offered. |
| `n` | Normally selects the cancel/“tell Codex differently” action. |
| `Esc` | Cancels the approval and aborts the active turn for command/edit approvals. |
| `Ctrl+C` | Also cancels the approval and aborts the active turn. |
| `o` | Opens the originating agent thread on cross-thread prompts; not a decision. |
| `Ctrl+A` or `Ctrl+Shift+A` | Opens the fullscreen approval view; not a decision. |

The default approval keymap is:

```text
approve:             y
approve_for_session: a
approve_for_prefix:  p
deny:                d
decline/cancel turn: esc, n
```

These bindings are user-configurable. The shortcut rendered beside an option reflects the active binding and is safer than assuming defaults.

### Digits are immediate

A bare digit is sufficient:

```text
2
```

The list handler selects option 2 and calls `accept()` immediately. Do not append Enter:

```text
2<Enter>
```

By the time Enter arrives, the approval overlay may already be gone. The extra Enter can reach the composer or a subsequent prompt.

### `Esc` semantics

For command and file-edit approvals:

```text
Esc
  → Cancel
  → ReviewDecision::Abort
  → interrupt_task()
```

Therefore this mapping is incorrect:

```text
Deny → Esc
```

unless the UI explicitly means **Cancel/abort the active turn**.

The label:

```text
No, and tell Codex what to do differently
```

should be mapped to a UI action such as `Cancel turn`, `Stop and redirect`, or similarly explicit wording.

A genuine non-aborting denial is:

```text
No, continue without running it (d)
```

but only when that row is actually present.

### Recommended Agent Island mapping

```text
Yes, proceed / Yes, just this once
    → y or the row's bare digit

session/conversation/files approval
    → a or the row's bare digit

persistent prefix/future-host approval
    → p or the row's bare digit

No, continue without...
    → d or the row's bare digit

No, and tell Codex what to do differently
    → cancel/abort turn, not ordinary deny
```

Using the row's bare digit is generally robust because it selects the exact decision Codex rendered. The parser must still understand the decision semantically before deciding what label to expose in Agent Island.

## 4. Non-decision content

Every numbered row in the command/edit approval overlay is currently a decision. The following surrounding content is display-only:

```text
Reason:
Permission rule:
Thread:
Environment:
Server:
$ command...
Field 1/1
file names
diff lines
parameter summaries
```

Keyboard-only actions that are not decisions include:

```text
o to open thread
Ctrl+A to open fullscreen
Ctrl+Shift+A to open fullscreen
```

There are no `show full command`, `explain`, or `edit first` numbered rows in the 0.146.1 command/edit approval overlay.

Do not classify a prompt as an approval merely because it contains:

```text
Press enter to confirm or esc to go back
```

That footer is used by unrelated interfaces, including:

- Model selection
- Settings
- Feedback
- Trust dialogs
- Agent pickers
- Confirmation dialogs

Generic `request_user_input` questions also use dotted numbered rows and the `›` selection marker. Their rows are arbitrary answers rather than approval decisions.

Detection should require an approval-specific title or option vocabulary, not the generic footer or numbering alone.

## 5. Structured alternatives to terminal scraping

### Recommended: `codex app-server`

`codex app-server` is the structured interface intended for rich clients, including the Codex VS Code extension. It provides bidirectional JSON-RPC over newline-delimited JSON on stdin/stdout by default.

It sends approvals as server-initiated requests and waits for a structured response from the client.

Relevant request methods include:

```text
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/permissions/requestApproval
mcpServer/elicitation/request
item/tool/requestUserInput
```

Requests include identifiers such as `threadId`, `turnId`, and `itemId`, plus structured command, working-directory, reason, permission, network, and available-decision data where applicable.

Command decisions include:

```json
{"decision":"accept"}
{"decision":"acceptForSession"}
{"decision":"decline"}
{"decision":"cancel"}
```

The protocol also supports structured exec-policy and network-policy amendments.

This is materially safer than terminal scraping because it distinguishes:

```text
decline → refuse the action without cancel semantics
cancel  → cancel/abort semantics
```

It also avoids terminal-width wrapping, ANSI redraws, localization concerns, shortcut customization, and accidental extra keystrokes.

Adopting app-server would change Agent Island from a passive terminal wrapper into a Codex client or app-server proxy, but it is the cleanest long-term integration.

### PermissionRequest hooks

Codex hooks provide another structured JSON surface. A `PermissionRequest` hook runs when Codex is about to ask for approval and may return:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

or:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Blocked by repository policy."
    }
  }
}
```

If the hook returns no decision, normal approval UI continues. A hook could bridge to Agent Island over IPC and block until the user responds.

Limitations:

- It is primarily a policy/decision hook, not the complete rich-client approval protocol.
- It does not reproduce every persistence choice exposed by app-server.
- Hook coverage and payloads vary by tool path.

### `codex exec --json`

`codex exec --json` emits machine-readable JSONL events for noninteractive automation. It is useful for CI and scripted runs, but it is not a drop-in interactive approval callback for the normal terminal TUI.

For an interactive desktop approval UI, app-server is the appropriate structured interface.

## 6. VS Code extension architecture

The Codex VS Code extension does not run the interactive Codex TUI inside a visible terminal.

It presents its own Codex sidebar/panel chat UI inside VS Code and uses `codex app-server` as the backend protocol. The extension may cause Codex to execute local commands, but approvals are represented through the extension's structured client UI rather than terminal text.

Consequences for Agent Island:

- A terminal-output scraper will not observe the VS Code extension's approval UI.
- Supporting the extension requires a structured app-server integration, an extension integration, or another explicit IPC path.
- The same app-server protocol is the best basis for supporting both standalone rich clients and editor-hosted Codex sessions.

## Implementation summary for Agent Island

The immediate parser/input corrections are:

1. Rename the action associated with `No, and tell Codex what to do differently` from **Deny** to an explicit cancel/abort-turn action.
2. Never send `Esc` for a non-aborting Deny action.
3. Treat a bare digit as a complete selection; do not append Enter.
4. Recognize `y`, `a`, `p`, `r`, `d`, and `n` as real default shortcuts with distinct meanings.
5. Confirm that option 1 is initially highlighted and bare Enter accepts it.
6. Parse `1.` rows, not `[1]` rows, and recognize `›` as the selected marker.
7. Do not use the generic `Press enter to confirm...` footer as the primary approval detector.
8. Keep generic request-user-input questions separate from command/edit approvals.
9. Prefer the structured `codex app-server` approval protocol for a durable integration.

