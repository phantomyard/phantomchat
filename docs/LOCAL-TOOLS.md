# Local tools and Provider contacts (desktop)

Two contact types from the contacts redesign run on the desktop app's bundled
phantombot engine (`electron/phantombot/`, pinned in `pin.json`).

## Provider contacts

An AI contact that is a persona of the bundled engine. The New Contact modal
(Provider, desktop only) lists `providers.list`, checks the token with
`providers.check`, and offers that account's models. Adding one:

1. `personas.create`, then `persona.configure` with `brain.native`
   (provider, model, key). The key goes into the persona's encrypted vault.
2. `persona.phantomchat.allow` with my npub (the only one it answers), then
   `persona.phantomchat.start`. The contact is the persona's npub.

A failure before the contact lands deletes the persona. Deleting the contact
deletes the persona: nsec, key, memory and history. The host starts every
persona with an allowlist when the app launches. Providers that need a base
URL are not offered yet: the engine's brain settings have no endpoint field.

A Provider contact runs on this PC with the persona's full tools, like a
phantom answering its principal. It has no Local tools switch yet: the
engine's hosted channel has no per-channel tools setting to turn off.

## Scan

The Phantom type's Scan button reads the phantombot **installed** on this PC
(not the bundled engine), version 1.1.475 or later:
`phantombot phantomchat --list --json`, then
`phantombot phantomchat --persona <p> --allow <my npub> --json` and
`phantombot restart`. The version is checked first, because an older
phantombot would ignore the flags and open its interactive setup.

## Local tools for Phantom contacts

A remote phantom (phantombot `device list|call`, #747) can run tools on this
PC when that contact's Local tools switch is ON. Turning it on shows one
native Allow dialog; off revokes at once. The gate is
`electron/localTools/`; the tools run in the bundled engine (`tools.run`,
Pi's own built-ins).

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

Each call is logged to `<userData>/local-tools/local-tools.log`: time, contact, tool, status
and exit, never commands or file contents.
