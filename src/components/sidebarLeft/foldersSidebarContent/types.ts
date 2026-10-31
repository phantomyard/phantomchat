import {JSX} from 'solid-js';
import type {MiddlewareHelper} from '@helpers/middleware';
import {TextWithEntities} from '@layer';


export type FolderItemPayload = {
  id?: number;
  icon: Icon;
  /**
   * Literal glyph to render in the icon slot instead of a font icon (2026-10-30,
   * when it was the Code folder's `#`). The icon font has no `#` and Sessions is
   * still the only folder that needs one, so it is drawn as text in the same
   * 30px slot with the same colour rules (`--selected` → primary/blue).
   */
  glyph?: string;
  iconDocId?: DocId;
  emojiIcon?: string;
  dontAnimate?: boolean;
  name?: JSX.Element;
  title?: TextWithEntities.textWithEntities;
  notifications?: {
    count: number,
    muted: boolean
  };
  chatsCount?: number | null;
};
