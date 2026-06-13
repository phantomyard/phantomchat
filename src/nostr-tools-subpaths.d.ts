// Ambient module declarations for nostr-tools subpath imports.
// Needed because tsconfig uses moduleResolution: "node" which doesn't
// support package.json "exports". Vite resolves them at runtime.
declare module 'nostr-tools/pure';
declare module 'nostr-tools/utils';
declare module 'nostr-tools/nip04';
declare module 'nostr-tools/nip06';
declare module 'nostr-tools/nip17';
declare module 'nostr-tools/nip19';
declare module 'nostr-tools/nip44';
declare module 'nostr-tools/nip59';
declare module 'nostr-tools/core';
