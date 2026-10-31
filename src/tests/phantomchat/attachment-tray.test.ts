/**
 * Composer attachment tray — DOM behaviour.
 *
 * The tray is the PhantomChat replacement for the per-pick `PopupNewMedia`
 * modal: staged thumbnails above the composer, per-file remove, one batch send.
 */

import AttachmentTray from '@components/chat/attachmentTray';
import {MAX_PENDING_ATTACHMENTS} from '@lib/phantomchat/composer-attachments';

function makeFile(name: string, type: string, size = 1024): File {
  const file = new File(['x'], name, {type});
  Object.defineProperty(file, 'size', {value: size, configurable: true});

  return file;
}

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  createObjectURL = vi.fn((file: Blob) => `blob:${(file as File).name}`);
  revokeObjectURL = vi.fn();
  (URL as any).createObjectURL = createObjectURL;
  (URL as any).revokeObjectURL = revokeObjectURL;
});

function tiles(tray: AttachmentTray): HTMLElement[] {
  return Array.from(tray.element.querySelectorAll('.attachment-tray-item')) as HTMLElement[];
}

describe('AttachmentTray', () => {
  it('starts hidden and empty', () => {
    const tray = new AttachmentTray();

    expect(tray.hasFiles()).toBe(false);
    expect(tray.element.classList.contains('hide')).toBe(true);
    expect(tiles(tray)).toHaveLength(0);
  });

  it('renders a thumbnail tile per staged file and un-hides', () => {
    const tray = new AttachmentTray();
    const rejected = tray.addFiles([makeFile('photo.png', 'image/png'), makeFile('clip.mp4', 'video/mp4'), makeFile('doc.pdf', 'application/pdf')]);

    expect(rejected).toHaveLength(0);
    expect(tray.hasFiles()).toBe(true);
    expect(tray.element.classList.contains('hide')).toBe(false);

    const [photo, clip, doc] = tiles(tray);
    expect(photo.querySelector('img')?.getAttribute('src')).toBe('blob:photo.png');
    expect(clip.querySelector('video')).not.toBeNull();
    expect(doc.querySelector('.attachment-tray-item-ext')?.textContent).toBe('PDF');
    expect(doc.querySelector('img')).toBeNull();
  });

  it('shows the filename under each tile', () => {
    const tray = new AttachmentTray();
    tray.addFiles([makeFile('holiday photo.png', 'image/png')]);

    expect(tray.element.querySelector('.attachment-tray-item-name')?.textContent).toBe('holiday photo.png');
  });

  it(`caps the batch at ${MAX_PENDING_ATTACHMENTS} and reports the overflow`, () => {
    const tray = new AttachmentTray();
    const files = Array.from({length: MAX_PENDING_ATTACHMENTS + 1}, (_, i) => makeFile(`f${i}.png`, 'image/png'));

    const rejected = tray.addFiles(files);

    expect(tiles(tray)).toHaveLength(MAX_PENDING_ATTACHMENTS);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBe('batch-full');
  });

  it('drops an oversized file instead of staging it', () => {
    const tray = new AttachmentTray();
    const rejected = tray.addFiles([makeFile('huge.png', 'image/png', 11 * 1024 * 1024)]);

    expect(tray.hasFiles()).toBe(false);
    expect(rejected[0].reason).toBe('too-large');
    expect(rejected[0].message).toContain('huge.png');
  });

  it('removes a tile and revokes its preview URL when the X is clicked', () => {
    const tray = new AttachmentTray();
    tray.addFiles([makeFile('photo.png', 'image/png')]);

    const removeBtn = tray.element.querySelector('.attachment-tray-item-remove') as HTMLButtonElement;
    removeBtn.click();

    expect(tray.hasFiles()).toBe(false);
    expect(tray.element.classList.contains('hide')).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:photo.png');
  });

  it('blocks removal while that file is in flight', () => {
    const tray = new AttachmentTray();
    tray.addFiles([makeFile('photo.png', 'image/png')]);
    const id = tray.pending[0].id;

    tray.markSending(id);
    tray.remove(id);

    expect(tray.pending).toHaveLength(1);
    expect((tray.element.querySelector('.attachment-tray-item-remove') as HTMLButtonElement).disabled).toBe(true);
  });

  it('announces every change so the composer can refresh the send button', () => {
    const tray = new AttachmentTray();
    const onChange = vi.fn();
    tray.onChange = onChange;

    tray.addFiles([makeFile('photo.png', 'image/png')]);
    expect(onChange).toHaveBeenCalledTimes(1);

    tray.remove(tray.pending[0].id);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('clears the tray and revokes every preview URL', () => {
    const tray = new AttachmentTray();
    tray.addFiles([makeFile('a.png', 'image/png'), makeFile('b.png', 'image/png')]);

    tray.clear();

    expect(tray.hasFiles()).toBe(false);
    expect(tiles(tray)).toHaveLength(0);
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  describe('sendAll()', () => {
    it('dispatches every file in staged order and empties the tray', async() => {
      const tray = new AttachmentTray();
      tray.addFiles([makeFile('a.png', 'image/png'), makeFile('b.png', 'image/png')]);
      const sent: string[] = [];

      const result = await tray.sendAll(async(item) => {
        sent.push(item.file.name);
      });

      expect(sent).toEqual(['a.png', 'b.png']);
      expect(result.failed).toBeUndefined();
      expect(tray.hasFiles()).toBe(false);
      expect(tiles(tray)).toHaveLength(0);
    });

    it('keeps the failed file and the unsent remainder staged for a retry', async() => {
      const tray = new AttachmentTray();
      tray.addFiles([makeFile('a.png', 'image/png'), makeFile('b.png', 'image/png'), makeFile('c.png', 'image/png')]);

      const result = await tray.sendAll(async(item) => {
        if(item.file.name === 'b.png') {
          throw new Error('bridge refused');
        }
      });

      expect(result.failed?.file.name).toBe('b.png');
      expect(tray.pending.map((item) => item.file.name)).toEqual(['b.png', 'c.png']);
      expect(tiles(tray)).toHaveLength(2);

      const failedTiles = tiles(tray).filter((el) => el.classList.contains('is-failed'));
      expect(failedTiles).toHaveLength(2);
      expect(tray.element.querySelector('.attachment-tray-item-status')?.textContent).toBe('!');
    });

    it('retries the leftovers on a second send', async() => {
      const tray = new AttachmentTray();
      tray.addFiles([makeFile('a.png', 'image/png'), makeFile('b.png', 'image/png')]);

      let failFirst = true;
      const attempt = async(item: {file: File}) => {
        if(failFirst && item.file.name === 'a.png') {
          failFirst = false;
          throw new Error('transient');
        }
      };

      await tray.sendAll(attempt);
      expect(tray.pending.map((item) => item.file.name)).toEqual(['a.png', 'b.png']);

      await tray.sendAll(attempt);
      expect(tray.hasFiles()).toBe(false);
    });

    it('revokes the preview URL of a file once it is sent', async() => {
      const tray = new AttachmentTray();
      tray.addFiles([makeFile('a.png', 'image/png')]);

      await tray.sendAll(async() => {});

      expect(revokeObjectURL).toHaveBeenCalledWith('blob:a.png');
    });
  });
});
