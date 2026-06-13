# Dicebear Fun Emoji Avatar Integration

## Summary

Integrate Dicebear fun-emoji as deterministic avatar generation for Nostra.chat. Every npub hex produces a unique, consistent emoji avatar used as universal fallback (replacing initials + gradient) and shown during onboarding.

## Decisions

| Decision | Choice |
|----------|--------|
| Fallback behavior | C+B: onboarding preview + persistent fallback + profile option |
| Onboarding placement | Step "Display Name" — emoji appears as profile preview |
| Scope | All peers — every npub gets a fun-emoji avatar |
| Where shown | Everywhere (contact list, chat bubbles, profile, topbar, sidebar) |
| Rendering | Blob URL with cache — integrates with existing `savedAvatarURLs` pipeline |

## Architecture

### New Module: `src/helpers/generateDicebearAvatar.ts`

Responsibilities:
- Takes a hex pubkey string as input
- Uses `@dicebear/core` + `@dicebear/collection` (fun-emoji style) to generate SVG
- Converts SVG string → Blob → Blob URL
- Maintains an in-memory cache (`Map<string, string>`) mapping hex → blob URL
- Exports a single async function: `generateDicebearAvatar(hex: string): Promise<string>`

### File Modifications

#### `src/components/avatarNew.tsx`
- In the fallback path (no photo available), instead of rendering initials + gradient:
  - Get the peer's hex pubkey (via `getPubkey(peerId)` from virtual-peers-db or from the user object)
  - Call `generateDicebearAvatar(hex)` to get a blob URL
  - Render as `<img src={blobURL}>` — same as normal photo avatars
- Keep initials + gradient as final fallback if hex is unavailable (defensive)

#### `src/lib/appManagers/appAvatarsManager.ts`
- Integrate dicebear blob URLs into `savedAvatarURLs` cache
- When no photo exists for a peer, check if a dicebear URL is cached or generate one
- This allows the existing `isAvatarCached()` flow to work with dicebear avatars

#### `src/pages/nostra/onboarding.ts`
- In the "display-name" step, add an avatar preview element
- On identity creation/import, generate the fun-emoji from the new npub's hex
- Display the emoji above or beside the display name input field

#### `src/components/peerProfile.tsx`
- Show the dicebear emoji as an avatar option in the profile view
- When user has a photo: emoji is accessible as "reset to generated avatar"
- When user has no photo: emoji is the displayed avatar

### Data Flow

```
Peer has photo?
  ├─ YES → Load photo as usual (appAvatarsManager.loadAvatar)
  └─ NO → Get peer's hex pubkey
           ├─ HAS HEX → generateDicebearAvatar(hex) → blob URL → <img>
           └─ NO HEX → initials + gradient (legacy fallback, defensive only)
```

### Hex Pubkey Access

- **Current user**: `useNostraIdentity().npub()` → decode with `decodePubkey()` → hex
- **Contacts/peers**: `getPubkey(peerId)` from `@lib/nostra/virtual-peers-db`
- **Injected P2P users**: `user.p2pPubkey` on synthetic user objects

### npm Dependencies

- `@dicebear/core` — core avatar generation engine
- `@dicebear/collection` — includes fun-emoji and all other styles

### Cache Strategy

- In-memory `Map<string, string>` in `generateDicebearAvatar.ts`
- Deterministic: same hex always produces same SVG, so cache is permanent per session
- No persistence needed — regeneration is fast and cheap
- Blob URLs are revoked on page unload (standard browser behavior)

## Scope

### Included
- Dicebear fun-emoji generation from npub hex
- Universal fallback replacing initials + gradient
- Onboarding preview in display-name step
- Profile option to use generated avatar
- Blob URL caching

### Excluded
- No upload of generated emoji to Nostr relays
- No additional onboarding steps
- No emoji customization/editor
- No style selector (fun-emoji only, can be extended later)
