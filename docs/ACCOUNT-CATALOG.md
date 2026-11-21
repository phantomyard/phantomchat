# Account catalog

Desktop and PWA clients on the catalog-capable Preview converge on an encrypted
account catalog. Neither device is a master. Each caches the merged catalog in
`phantomchat-account-catalog` IndexedDB, keyed by the account public key.

Folder definitions have stable UUIDs (existing folders retain a `legacy-<id>`
identity). Folder definitions, each included/excluded/pinned peer membership,
folder order and each group's archive placement are independent registers. An
edit receives a persisted logical counter and device ID. The counter advances
beyond every observed revision; the highest `(counter, device ID)` wins a
conflict on the same register. Unrelated edits survive. Folder deletion and
membership removal leave permanent tombstones; absence is never a deletion.
Numeric UI folder IDs are assigned deterministically when two offline devices
create different UUID folders with the same numeric ID.

The catalog also carries the group/session roster, including durable deletion
facts. It uses the existing group merge and deliberate-add proof rules rather
than allowing an automatic metadata refresh to resurrect a deleted group.
Group class still derives the local peer ID; a catalog archive record cannot
create a group or confer membership. Archive placement revisions also ride the
legacy group sync record so an unrelated newer rename cannot undo placement.

NIP-44 encryption uses the account's self-conversation key. Signed kind-30078
snapshots are stored at separate `phantomchat.chat/catalog-v1/<device>/<shard>`
addresses, tagged `t=phantomchat.chat/catalog-v1`. This prevents concurrent
publishers from replacing each other's only copy. Clients query their own
authored events, verify signatures, validate the decrypted schema and merge all
shards. Payloads are divided at roughly 24KB, below NIP-44's per-payload limit;
an individually oversized entry fails publication without discarding the cache.
A publish is confirmed by reading the device's state back from the relay.

Reconciliation runs automatically every 15 seconds, on foreground/online, and
after local edits. Failed attempts have a 20-second bound and back off from four
seconds to one minute. Abandoned network completions cannot resume later local
writes. The browser lock serializes catalog passes across tabs; IndexedDB
transactions allocate revisions atomically. Worker folder replacement compares
the expected current filters before writing, so a concurrent local edit causes
a retry. Group archive projection updates only archive fields in one transaction.
Every successful catalog pass also compares persisted worker dialog rows with the
current group store. Missing rows and stale folder indices are rebuilt through
`reloadConversation`; orphan group/session rows are swept with a fresh store
recheck before removal. This repairs a stale chat list even when no catalog
register changed and the legacy groups snapshot remains unreadable. Group data,
message history and drafts are retained. Synthetic group/session peers never
subscribe to Telegram channel-difference polling (they have no channel `pts`);
relay catch-up remains responsible for their history.

On upgrade, cached folder/archive entries seed revision zero. Cached folder
migration retains the existing local modified/published stamp so unpublished
offline edits beat an older legacy relay snapshot; subsequent edits use logical
revisions. The legacy folder
relay snapshot is imported once, as a union, without treating missing entries as
deletes. Group/session records and their delete proofs are also seeded from the
existing group store and sync. Existing identity, message and group database
versions remain unchanged. The new cache is additive and removed by Preview's
logout/reset cleanup. Old clients do not understand the new folder catalog:
**both apps must use the catalog-capable Preview for folder convergence**.
Rolling back preserves their existing databases but does not add this protocol
to the old frontend.

`account-catalog.test.ts` checks convergence, conflict ordering, permanent deletes,
offline edits, legacy import, account isolation, concurrent clock allocation and
fresh-device roster recovery. `e2e-account-catalog.ts` exercises real PWA Chromium
and Linux Electron clients against an isolated signed-event relay, including
archive/unarchive, conflicting offline folder creates and stale snapshot replay.
No personal account or production relay is used by these tests.
