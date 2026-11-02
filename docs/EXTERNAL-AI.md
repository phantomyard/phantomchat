# External AI and Local PC access (#276)

The desktop app embeds the Pi runtime in its main process. One embed serves two
features. "Pi" is an implementation detail and never appears in the UI.

| Chat with | Who runs the agent loop | Model and effort | Tools run on |
| --- | --- | --- | --- |
| **External AI** | Pi, on its host PC | Edit the contact, on the host PC | The host PC |
| A remote phantom | The remote phantom | Not available | This PC, only if that contact's switch is ON |

## Code map

| Path | What |
| --- | --- |
| `electron/localAi/piRuntime.ts` | Providers, models, sessions, tools, in a private data folder |
| `electron/localAi/localAccess.ts` | The whole Local PC access gate, with no Electron imports |
| `electron/localAi/localTools.ts` | Runs a call, cancels it, logs metadata |
| `electron/localAi/externalAiContact.ts` | One External AI on its relay link |
| `electron/localAi/routing.ts` | Who a group message is for |
| `electron/localAi/localAiHost.ts` | Ties those together |
| `electron/localAi/localAiIpc.ts` | IPC and the native dialogs |
| `src/lib/phantomchat/local-ai.ts` | Renderer side: everything that needs the principal's key |

All data is under `<userData>/local-ai`. `PI_CODING_AGENT_DIR` points there before the
first SDK import and discovery is off, so a standalone Pi on the same machine is neither
read nor changed, in either direction.

## Trust contract

Normative: settled, and not open for debate in review.

Trust between a principal and a phantom is **mutual and already established by the npub
pairing**:

1. The principal adds the phantom's npub to their PhantomChat contacts.
2. The phantom adds the principal's npub to its trusted channels (phantombot
   `allowed_npubs` / trusted principal list).

When both are true, that phantom acts **in the trusted tier** on the principal's behalf.
Local PC tools are the same contract, not a new one.

- **One native Allow dialog per contact, shown only when the switch is turned ON.** No
  per-call approval prompts, escort judge, or tool allowlist for calls from a contact
  with the switch ON.
- Reviews should flag *concrete* defects (for example a non-trusted peer can reach the
  tools, or a spoofable identity check), not re-litigate the trust model.
- The untrusted-input perimeter in phantombot is about untrusted content (email, web,
  webhooks). It does not apply to a trusted phantom talking to its own principal's app.

## The gate: per-contact "Local PC access" switch

- Every contact gets the switch in contact info, on the desktop app, **OFF by default**:
  new, existing, human or phantom.
- ON shows the native Allow dialog once. Main shows it and stores the result, and it is
  not shown again unless the switch is turned OFF and back ON.
- OFF revokes immediately: in-flight calls are cancelled and later ones refused.
- The state is stored by the main process on this device and is never derived from
  anything the remote sends. A kind-0 `bot: true` grants nothing.
- Signing in with a different identity turns every switch OFF.

Tools answer **only** when the sender npub has the switch ON and the request arrived over
NIP-17, with its signature verified against that npub. A Session with that contact counts
as the contact, whoever else is in it. Other groups do not.

Everything else gets no answer at all, and the capability is not advertised.

## Tool protocol

NIP-17 rumors with the tags `["phantomchat-local-tools", "1"]` and `["control", "true"]`,
and JSON in `content` with `"type": "phantomchat-local-tools"`. Both directions must carry
all three, because software that predates the protocol has to ignore it: older PhantomChat
clients drop the control tag, and phantombot drops JSON whose string `type` is not `text`.
Without them, a client renders the JSON and a phantom runs a turn on it.

They are taken off the receive pipeline before it can render anything, and only the
desktop app acts on them. They go only to the other party, with no copy to self. The
objects below leave out the `type` field.

From the phantom:

```jsonc
{"t": "hello"}                      // answered with capability if the switch is ON
{
  "t": "call",
  "callId": "abc-1",                // [\w-]{1,64}; a replay never runs twice
  "deviceId": "<32 hex>",           // other devices ignore the call
  "tool": "bash",                   // bash | read | write | edit | ls | find | grep
  "args": {"command": "ls"},        // the tool's own arguments
  "expiresAt": 1790000000000,       // Unix ms, at most 10 minutes ahead
  "timeoutMs": 120000,              // optional; default 2 minutes, at most 10
  "groupId": "..."                  // optional; set when calling from a group-class chat
}
{"t": "cancel", "callId": "abc-1"}  // only the contact that made the call
```

From the app:

```jsonc
{"t": "capability", "deviceId": "...", "deviceName": "...", "platform": "linux", "tools": ["bash", "..."]}
{"t": "revoked", "deviceId": "..."}
{"t": "result", "callId": "abc-1", "seq": 0, "total": 1, "data": "..."}
```

Join `data` across `seq`, then parse it: `{status: "ok" | "error" | "cancelled" | "timeout",
output, exit?, truncated?}`. The app sends `capability` when the switch turns ON and on each
launch. A phantom that hears nothing treats the device as unavailable.

Each call is logged to `<userData>/local-ai/local-tools.log`: time, contact, tool, status
and exit, never commands or file contents.

## External AI contacts

- **Identity:** each has its own npub. The nsec stays in the host's main process and never
  reaches the renderer or contact sync. No backup or transfer: losing the PC loses the
  identity, as with a phantom today.
- **Creating:** the first is created and pinned when the first provider is configured.
  "New External AI" in Providers adds more.
- **Deleting on the host:** a native confirmation, then the nsec and Pi history are destroyed.
- **Where it shows:** the contact and chats appear on every device, and a phone can drive
  the host while it is on. Providers and model and effort editing are host only.
- **Who drives it:** the principal only. Anything else is dropped, group invites included.
- **Offline:** on launch, prompts over an hour old do not run and get one offline reply.
- **History:** Pi session files stay on the host, are not pruned, and go when the contact
  is deleted. Relays carry only the visible chat.

In groups and Sessions it follows phantombot's rules, triggered only by the principal: a
lone bot answers everything, and otherwise it replies when named and keeps answering
unnamed follow-ups until someone else is named. Other people's messages are context only.
Unlike phantombot's `matchPersonaNames`, "External AI" does not match "External AI 2".

## Accepted risks

- A renderer XSS, for example from a malicious message, could reach Pi. External AI has no
  dialog or switch, and the Allow dialog limits remote tools by contact, not by call, so
  message and tool output must be sanitised before rendering.
- Other people's group messages could steer an External AI.

## Tests

- Unit: `electron/localAi/*.test.ts`.
- End-to-end: `src/tests/e2e/e2e-external-ai-desktop.ts`, real Electron with real
  gift-wraps over a local relay and a fake model server.
- Packaging: `--pi-embed-probe` in `app-release.yml`.
