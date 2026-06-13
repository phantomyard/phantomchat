import {decodePubkey} from './nostr-identity';
import {generateDicebearAvatar} from '@helpers/generateDicebearAvatar';

/**
 * Resolve an image URL for embedding as the center logo inside a QR code.
 * Returns the kind 0 `picture` if present; otherwise generates a deterministic
 * dicebear avatar from the npub. The returned string is either a remote URL
 * (picture) or a local blob URL (dicebear SVG) — both are acceptable inputs
 * for `qr-code-styling`'s `image` option.
 */
export async function getAvatarForQR(npub: string, picture?: string | null): Promise<string> {
  if(picture && picture.trim().length > 0) {
    return picture;
  }
  const hex = decodePubkey(npub);
  return generateDicebearAvatar(hex);
}
