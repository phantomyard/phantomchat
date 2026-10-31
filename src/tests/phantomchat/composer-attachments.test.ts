/**
 * Composer attachment tray — batching rules.
 *
 * PhantomChat publishes one rumor per file, so the composer stages a batch and
 * dispatches it sequentially. These tests pin the rules that batch relies on:
 * the 5-file cap, the Blossom size ceilings, duplicate suppression, ordering
 * and stop-on-first-failure.
 */

import {
  addPendingAttachments,
  getAttachmentKind,
  getAttachmentMediaType,
  getAttachmentSizeLimit,
  isPhantomChatPeerId,
  MAX_PENDING_ATTACHMENTS,
  PendingAttachment,
  removePendingAttachment,
  sendPendingAttachments,
  validateAttachment
} from '@lib/phantomchat/composer-attachments';
import {MAX_PHOTO_SIZE, MAX_VIDEO_SIZE} from '@lib/phantomchat/blossom-client';

function makeFile(name: string, type: string, size = 1024): File {
  const file = new File(['x'], name, {type});
  Object.defineProperty(file, 'size', {value: size, configurable: true});

  return file;
}

const noPreview = (): undefined => undefined;

describe('composer attachment batching', () => {
  describe('peer detection', () => {
    it('treats 1:1 P2P peer ids as PhantomChat chats', () => {
      expect(isPhantomChatPeerId(1_600_000_000_000_000)).toBe(true);
      expect(isPhantomChatPeerId('1600000000000001')).toBe(true);
    });

    it('treats group peer ids as PhantomChat chats', () => {
      expect(isPhantomChatPeerId(-2_000_000_000_000_001)).toBe(true);
    });

    it('leaves ordinary tweb peer ids alone', () => {
      expect(isPhantomChatPeerId(777000)).toBe(false);
      expect(isPhantomChatPeerId(-1001234567890)).toBe(false);
      expect(isPhantomChatPeerId(Number.NaN)).toBe(false);
    });
  });

  describe('file classification', () => {
    it('maps mime types to the bridge media types', () => {
      expect(getAttachmentMediaType(makeFile('a.png', 'image/png'))).toBe('image');
      expect(getAttachmentMediaType(makeFile('a.mp4', 'video/mp4'))).toBe('video');
      expect(getAttachmentMediaType(makeFile('a.pdf', 'application/pdf'))).toBe('file');
      expect(getAttachmentMediaType(makeFile('a.bin', ''))).toBe('file');
    });

    it('sends only images and videos as media', () => {
      expect(getAttachmentKind(makeFile('a.png', 'image/png'))).toBe('media');
      expect(getAttachmentKind(makeFile('a.mp4', 'video/mp4'))).toBe('media');
      expect(getAttachmentKind(makeFile('a.pdf', 'application/pdf'))).toBe('document');
    });

    it('uses the Blossom ceilings for each type', () => {
      expect(getAttachmentSizeLimit(makeFile('a.png', 'image/png'))).toBe(MAX_PHOTO_SIZE);
      expect(getAttachmentSizeLimit(makeFile('a.mp4', 'video/mp4'))).toBe(MAX_VIDEO_SIZE);
      expect(getAttachmentSizeLimit(makeFile('a.pdf', 'application/pdf'))).toBe(MAX_VIDEO_SIZE);
    });
  });

  describe('validation', () => {
    it('accepts a file at exactly the photo ceiling', () => {
      expect(validateAttachment(makeFile('a.png', 'image/png', MAX_PHOTO_SIZE))).toBeUndefined();
    });

    it('rejects a photo one byte over the ceiling', () => {
      const rejected = validateAttachment(makeFile('a.png', 'image/png', MAX_PHOTO_SIZE + 1));
      expect(rejected?.reason).toBe('too-large');
      expect(rejected?.message).toContain('a.png');
    });

    it('rejects a video over the 50MB ceiling', () => {
      expect(validateAttachment(makeFile('a.mp4', 'video/mp4', MAX_VIDEO_SIZE + 1))?.reason).toBe('too-large');
    });

    it('rejects an empty file', () => {
      expect(validateAttachment(makeFile('a.png', 'image/png', 0))?.reason).toBe('empty');
    });
  });

  describe('addPendingAttachments()', () => {
    it(`stages up to ${MAX_PENDING_ATTACHMENTS} files and rejects the rest`, () => {
      const files = Array.from({length: MAX_PENDING_ATTACHMENTS + 2}, (_, i) => makeFile(`f${i}.png`, 'image/png'));
      const {items, added, rejected} = addPendingAttachments([], files, noPreview);

      expect(MAX_PENDING_ATTACHMENTS).toBe(5);
      expect(added).toHaveLength(5);
      expect(items).toHaveLength(5);
      expect(rejected.map((r) => r.reason)).toEqual(['batch-full', 'batch-full']);
    });

    it('counts already-staged files against the cap', () => {
      const first = addPendingAttachments([], [makeFile('a.png', 'image/png'), makeFile('b.png', 'image/png')], noPreview);
      const second = addPendingAttachments(first.items, [
        makeFile('c.png', 'image/png'),
        makeFile('d.png', 'image/png'),
        makeFile('e.png', 'image/png'),
        makeFile('f.png', 'image/png')
      ], noPreview);

      expect(second.added).toHaveLength(3);
      expect(second.items).toHaveLength(5);
      expect(second.rejected.map((r) => r.reason)).toEqual(['batch-full']);
    });

    it('suppresses the same file staged twice', () => {
      const file = makeFile('a.png', 'image/png');
      const first = addPendingAttachments([], [file], noPreview);
      const second = addPendingAttachments(first.items, [file], noPreview);

      expect(second.added).toHaveLength(0);
      expect(second.rejected[0].reason).toBe('duplicate');
    });

    it('never mutates the array it is given', () => {
      const existing: PendingAttachment[] = [];
      const {items} = addPendingAttachments(existing, [makeFile('a.png', 'image/png')], noPreview);

      expect(existing).toHaveLength(0);
      expect(items).toHaveLength(1);
    });

    it('keeps the selection order in the staged batch', () => {
      const files = ['a.png', 'b.png', 'c.png'].map((name) => makeFile(name, 'image/png'));
      const {items} = addPendingAttachments([], files, noPreview);

      expect(items.map((item) => item.file.name)).toEqual(['a.png', 'b.png', 'c.png']);
    });

    it('previews only media files', () => {
      const {items} = addPendingAttachments([], [makeFile('a.png', 'image/png'), makeFile('a.pdf', 'application/pdf')], (file) => `blob:${file.name}`);

      expect(items[0].previewURL).toBe('blob:a.png');
      expect(items[1].previewURL).toBe('blob:a.pdf');
    });
  });

  describe('removePendingAttachment()', () => {
    it('drops the item and revokes its preview URL', () => {
      const revoke = vi.fn();
      const originalRevoke = URL.revokeObjectURL;
      URL.revokeObjectURL = revoke as any;

      try {
        const {items} = addPendingAttachments([], [makeFile('a.png', 'image/png')], () => 'blob:a');
        const result = removePendingAttachment(items, items[0].id);

        expect(result).toHaveLength(0);
        expect(revoke).toHaveBeenCalledWith('blob:a');
      } finally {
        URL.revokeObjectURL = originalRevoke;
      }
    });

    it('is a no-op for an unknown id', () => {
      const {items} = addPendingAttachments([], [makeFile('a.png', 'image/png')], noPreview);
      expect(removePendingAttachment(items, 'nope')).toHaveLength(1);
    });
  });

  describe('sendPendingAttachments()', () => {
    it('dispatches every file in staged order, one at a time', async() => {
      const {items} = addPendingAttachments([], ['a.png', 'b.png', 'c.png'].map((n) => makeFile(n, 'image/png')), noPreview);
      const order: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;

      const result = await sendPendingAttachments(items, async(item) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        order.push(item.file.name);
        inFlight--;
      });

      expect(order).toEqual(['a.png', 'b.png', 'c.png']);
      expect(maxInFlight).toBe(1);
      expect(result.sent).toHaveLength(3);
      expect(result.remaining).toHaveLength(0);
      expect(result.failed).toBeUndefined();
    });

    it('stops at the first failure and leaves the failed file plus the remainder staged', async() => {
      const {items} = addPendingAttachments([], ['a.png', 'b.png', 'c.png'].map((n) => makeFile(n, 'image/png')), noPreview);
      const attempted: string[] = [];

      const result = await sendPendingAttachments(items, async(item) => {
        attempted.push(item.file.name);
        if(item.file.name === 'b.png') {
          throw new Error('bridge refused');
        }
      });

      expect(attempted).toEqual(['a.png', 'b.png']);
      expect(result.sent.map((item) => item.file.name)).toEqual(['a.png']);
      expect(result.failed?.file.name).toBe('b.png');
      expect(result.remaining.map((item) => item.file.name)).toEqual(['b.png', 'c.png']);
    });

    it('reports failures to the hooks in dispatch order', async() => {
      const {items} = addPendingAttachments([], [makeFile('a.png', 'image/png'), makeFile('b.png', 'image/png')], noPreview);
      const events: string[] = [];

      await sendPendingAttachments(items, async(item) => {
        if(item.file.name === 'a.png') throw new Error('nope');
      }, {
        onSending: (item) => events.push(`sending:${item.file.name}`),
        onSent: (item) => events.push(`sent:${item.file.name}`),
        onFailed: (item) => events.push(`failed:${item.file.name}`)
      });

      expect(events).toEqual(['sending:a.png', 'failed:a.png']);
    });

    it('sends nothing when the batch is empty', async() => {
      const send = vi.fn(async() => {});

      const result = await sendPendingAttachments([], send);

      expect(send).not.toHaveBeenCalled();
      expect(result.sent).toHaveLength(0);
      expect(result.remaining).toHaveLength(0);
    });
  });
});
