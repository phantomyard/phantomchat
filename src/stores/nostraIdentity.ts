import {createRoot, createSignal} from 'solid-js';
import rootScope from '@lib/rootScope';

const [npub, setNpub] = createRoot(() => createSignal<string | null>(null));
const [displayName, setDisplayName] = createRoot(() => createSignal<string | null>(null));
const [nip05, setNip05] = createRoot(() => createSignal<string | null>(null));
const [picture, setPicture] = createRoot(() => createSignal<string | null>(null));
const [about, setAbout] = createRoot(() => createSignal<string | null>(null));
const [website, setWebsite] = createRoot(() => createSignal<string | null>(null));
const [lud16, setLud16] = createRoot(() => createSignal<string | null>(null));
const [banner, setBanner] = createRoot(() => createSignal<string | null>(null));
const [isLocked, setIsLocked] = createRoot(() => createSignal(false));
const [protectionType, setProtectionType] = createRoot(() => createSignal<'none' | 'pin' | 'passphrase'>('none'));

rootScope.addEventListener('nostra_identity_loaded', (data) => {
  setNpub(data.npub);
  setDisplayName(data.displayName || null);
  setNip05(data.nip05 || null);
  setPicture(data.picture || null);
  setAbout(data.about || null);
  setWebsite(data.website || null);
  setLud16(data.lud16 || null);
  setBanner(data.banner || null);
  setProtectionType(data.protectionType);
  setIsLocked(false);
});

rootScope.addEventListener('nostra_identity_locked', () => {
  setIsLocked(true);
});

rootScope.addEventListener('nostra_identity_unlocked', (data) => {
  setNpub(data.npub);
  setIsLocked(false);
});

rootScope.addEventListener('nostra_identity_updated', (data) => {
  if(data.displayName !== undefined) setDisplayName(data.displayName || null);
  if(data.nip05 !== undefined) setNip05(data.nip05 || null);
  if(data.picture !== undefined) setPicture(data.picture || null);
  if(data.about !== undefined) setAbout(data.about || null);
  if(data.website !== undefined) setWebsite(data.website || null);
  if(data.lud16 !== undefined) setLud16(data.lud16 || null);
  if(data.banner !== undefined) setBanner(data.banner || null);
});

export default function useNostraIdentity() {
  return {
    npub,
    displayName,
    nip05,
    picture,
    about,
    website,
    lud16,
    banner,
    isLocked,
    protectionType
  };
}
