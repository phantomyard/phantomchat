import {JSX} from 'solid-js';
import type {MiddlewareHelper} from '@helpers/middleware';
import {TextWithEntities} from '@layer';


export type FolderItemPayload = {
  id?: number;
  icon: Icon;
  /**
   * Text glyph rendered in the icon slot instead of an icomoon icon, for rail
   * entries that are not folders (Code Mode's `#`). Inherits the icon size,
   * weight and colour so it matches the neighbouring icons exactly.
   */
  iconText?: string;
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
