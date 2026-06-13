/*
 * PhantomChat synthetic sticker pack.
 *
 * In PhantomChat mode there are no Telegram sticker sets. We ship 25 static
 * Fluent Emoji PNGs (MIT, Microsoft) under `public/assets/fluent-emoji/`
 * and expose them as a single synthetic sticker set so users can click
 * a "sticker" in the emoticons-picker and send it.
 *
 * Implementation is pure UI + click interception:
 *  - `appStickersManager.getAllStickers()` prepends this set.
 *  - `appStickersManager.getStickerSet()` short-circuits for our id.
 *  - `appDocsManager.getDoc()` returns these synthetic docs by id so the
 *    sticker grid can resolve them on visibility.
 *  - `wrapSticker` renders `<img>` when a doc has `phantomchat_fluent_url`.
 *  - `EmoticonsDropdown.sendDocId` intercepts clicks on `phantomchat:*` ids
 *    and sends a plain text message containing the emoji character.
 *    That single-emoji bubble then renders big via `wrapStickerEmoji`
 *    which already paints the same Fluent PNG.
 *
 * No MTProto upload, no real Document, no worker bridge. The Document
 * shape is shaped to satisfy TS + downstream code paths only.
 */

import type {MyDocument} from '@appManagers/appDocsManager';
import type {Document, DocumentAttribute, MessagesStickerSet, StickerSet} from '@layer';

// Stable synthetic id. Real Telegram sticker set ids are numeric bigint
// strings; this is deliberately non-numeric so it never collides.
export const PHANTOMCHAT_STICKER_SET_ID = 'phantomchat-fluent-emoji';
export const PHANTOMCHAT_STICKER_SET_ACCESS_HASH = 'phantomchat';
export const PHANTOMCHAT_STICKER_DOC_PREFIX = 'phantomchat:';

// Emoji → base slug. Kept in sync with `fluent-emoji.ts`, but duplicated
// here so the pack has a stable ordering and we can iterate without
// re-parsing the lookup table. Extend BOTH if you add new assets.
const PHANTOMCHAT_STICKER_EMOJI: ReadonlyArray<{emoji: string, slug: string}> = [
  {emoji: '❤️',        slug: 'red_heart'},
  {emoji: '\u{1F44D}',           slug: 'thumbs_up'},
  {emoji: '\u{1F44E}',           slug: 'thumbs_down'},
  {emoji: '\u{1F525}',           slug: 'fire'},
  {emoji: '\u{1F389}',           slug: 'party_popper'},
  {emoji: '\u{1F38A}',           slug: 'confetti_ball'},
  {emoji: '\u{1F382}',           slug: 'birthday_cake'},
  {emoji: '\u{1F381}',           slug: 'wrapped_gift'},
  {emoji: '\u{1F384}',           slug: 'christmas_tree'},
  {emoji: '\u{1F332}',           slug: 'evergreen_tree'},
  {emoji: '\u{1F3DE}️',     slug: 'national_park'},
  {emoji: '⛺',              slug: 'tent'},
  {emoji: '\u{1F30C}',           slug: 'milky_way'},
  {emoji: '\u{1F308}',           slug: 'rainbow'},
  {emoji: '⭐',              slug: 'star'},
  {emoji: '\u{1F319}',           slug: 'crescent_moon'},
  {emoji: '☀️',        slug: 'sun'},
  {emoji: '\u{1F339}',           slug: 'rose'},
  {emoji: '✨',              slug: 'sparkles'},
  {emoji: '\u{1F3A8}',           slug: 'artist_palette'},
  {emoji: '\u{1F602}',           slug: 'face_with_tears_of_joy'},
  {emoji: '\u{1F60D}',           slug: 'smiling_face_with_heart_eyes'},
  {emoji: '\u{1F622}',           slug: 'crying_face'},
  {emoji: '\u{1F64F}',           slug: 'folded_hands'},
  {emoji: '\u{1F4AF}',           slug: 'hundred_points'}
];

function makeDocId(slug: string): string {
  return PHANTOMCHAT_STICKER_DOC_PREFIX + slug;
}

export function isPhantomChatStickerDocId(docId: DocId | string): boolean {
  return typeof docId === 'string' && docId.startsWith(PHANTOMCHAT_STICKER_DOC_PREFIX);
}

/** Shape-compatible `stickerSet` header for the synthetic pack. */
export function getPhantomChatStickerSetHeader(): StickerSet.stickerSet {
  return {
    _: 'stickerSet',
    id: PHANTOMCHAT_STICKER_SET_ID as any,
    access_hash: PHANTOMCHAT_STICKER_SET_ACCESS_HASH as any,
    title: 'PhantomChat Emoji',
    short_name: 'phantomchat_fluent',
    count: PHANTOMCHAT_STICKER_EMOJI.length,
    hash: 0,
    thumb_version: 0,
    pFlags: {}
  } as StickerSet.stickerSet;
}

/** Build one synthetic Document per emoji. */
function buildPhantomChatDocuments(): MyDocument[] {
  return PHANTOMCHAT_STICKER_EMOJI.map(({emoji, slug}) => {
    const id = makeDocId(slug);
    const stickerAttr: DocumentAttribute.documentAttributeSticker = {
      _: 'documentAttributeSticker',
      alt: emoji,
      stickerset: {
        _: 'inputStickerSetID',
        id: PHANTOMCHAT_STICKER_SET_ID as any,
        access_hash: PHANTOMCHAT_STICKER_SET_ACCESS_HASH as any
      },
      pFlags: {}
    } as any;
    const imageAttr: DocumentAttribute.documentAttributeImageSize = {
      _: 'documentAttributeImageSize',
      w: 256,
      h: 256
    };

    const doc: Document.document & {
      phantomchat_fluent_url: string,
      phantomchat_emoji: string,
      sticker: number,
      animated: boolean,
      type: 'sticker',
      stickerEmojiRaw: string
    } = {
      _: 'document',
      id: id as any,
      access_hash: PHANTOMCHAT_STICKER_ACCESS_HASH_LONG as any,
      file_reference: new Uint8Array(0) as any,
      date: 0,
      mime_type: 'image/png',
      size: 0,
      dc_id: 0,
      attributes: [stickerAttr, imageAttr],
      thumbs: [],
      pFlags: {} as any,
      // tweb-local enrichments (mirror what appDocsManager.saveDoc adds):
      sticker: 1,
      animated: false,
      type: 'sticker',
      stickerEmojiRaw: emoji,
      // PhantomChat marker — consumed by wrapSticker + sendDocId.
      phantomchat_fluent_url: `assets/fluent-emoji/${slug}.png`,
      phantomchat_emoji: emoji
    };

    return doc as unknown as MyDocument;
  });
}

// `access_hash` is typed as long (bigint-string) — keep distinct from
// the set-level hash so downstream code doesn't confuse them.
const PHANTOMCHAT_STICKER_ACCESS_HASH_LONG = '0';

let _cachedDocs: MyDocument[] | undefined;
let _cachedDocsById: Map<string, MyDocument> | undefined;
let _cachedDocsByEmoji: Map<string, MyDocument> | undefined;

// `cleanEmoji` (richTextProcessor/fixEmoji) strips U+FE0F variation
// selectors + skin-tone modifiers — replicate inline so this module
// stays free of richTextProcessor deps.
function stripVariationAndSkin(emoji: string): string {
  return emoji.replace(/️/g, '').replace(/\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}/gu, '');
}

export function getPhantomChatStickerDocuments(): MyDocument[] {
  if(!_cachedDocs) {
    _cachedDocs = buildPhantomChatDocuments();
    _cachedDocsById = new Map(_cachedDocs.map((d) => [String(d.id), d]));
    _cachedDocsByEmoji = new Map();
    for(const d of _cachedDocs) {
      const raw = (d as any).phantomchat_emoji as string;
      if(!raw) continue;
      _cachedDocsByEmoji.set(raw, d);
      const cleaned = stripVariationAndSkin(raw);
      if(cleaned !== raw) _cachedDocsByEmoji.set(cleaned, d);
    }
  }
  return _cachedDocs;
}

export function getPhantomChatStickerDocById(docId: DocId | string): MyDocument | undefined {
  if(!isPhantomChatStickerDocId(docId)) return undefined;
  if(!_cachedDocsById) getPhantomChatStickerDocuments();
  return _cachedDocsById!.get(String(docId));
}

/**
 * Look up the synthetic PhantomChat doc for a given emoji character.
 * Matches both the raw form (with U+FE0F) and the cleaned form so callers
 * pre/post `cleanEmoji` both resolve.
 */
export function getPhantomChatStickerDocByEmoji(emoji: string): MyDocument | undefined {
  if(!emoji) return undefined;
  if(!_cachedDocsByEmoji) getPhantomChatStickerDocuments();
  const direct = _cachedDocsByEmoji!.get(emoji);
  if(direct) return direct;
  return _cachedDocsByEmoji!.get(stripVariationAndSkin(emoji));
}

/** Full `messages.stickerSet` response, shape-compatible. */
export function getPhantomChatStickerSet(): MessagesStickerSet.messagesStickerSet {
  const set = getPhantomChatStickerSetHeader();
  const documents = getPhantomChatStickerDocuments();
  return {
    _: 'messages.stickerSet',
    set,
    packs: [],
    keywords: [],
    documents: documents as unknown as Document[]
  } as MessagesStickerSet.messagesStickerSet;
}

/** Extract the emoji character carried by a synthetic sticker doc. */
export function getPhantomChatStickerEmoji(doc: MyDocument): string | undefined {
  const phantomchat = (doc as any)?.phantomchat_emoji;
  if(typeof phantomchat === 'string') return phantomchat;
  // Fallback via the sticker attribute's `alt` field.
  const attr = doc?.attributes?.find((a) => a._ === 'documentAttributeSticker') as DocumentAttribute.documentAttributeSticker | undefined;
  return attr?.alt;
}
