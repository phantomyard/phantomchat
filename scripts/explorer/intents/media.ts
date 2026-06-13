import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext} from '../../../src/tests/fuzz/types';

const PasteImageParams = z.object({
  user: z.enum(['userA', 'userB'])
});

const DragDropFileParams = z.object({
  user: z.enum(['userA', 'userB']),
  fileName: z.string().min(1).max(80),
  contentBase64: z.string()
});

const RecordVoiceParams = z.object({
  user: z.enum(['userA', 'userB']),
  durationMs: z.number().int().min(500).max(60_000)
});

const pageOf = (u: 'userA'|'userB'): 'A'|'B' => u === 'userA' ? 'A' : 'B';

const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// Replay traces sometimes carry a redacted placeholder for large base64 fields
// (e.g. "<tiny-text>", "<truncated>"). Detect non-base64 content and substitute
// a real tiny PNG so replay is repeatable.
function safeBase64(input: string): string {
  return input.length >= 8 && /^[A-Za-z0-9+/=]+$/.test(input) ? input : TINY_PNG_BASE64;
}

export const paste_image_to_input: IntentDef<z.infer<typeof PasteImageParams>> = {
  name: 'paste_image_to_input',
  area: 'media',
  paramsSchema: PasteImageParams,
  description: 'Paste a small PNG image into the chat input via clipboard. Tests image-paste + Blossom upload path.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      const input = u.page.locator('.chat-input [contenteditable="true"]').first();
      await input.focus();
      await u.page.evaluate(async(b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const file = new File([blob], 'pasted.png', {type: 'image/png'});
        const dt = new DataTransfer();
        dt.items.add(file);
        const ev = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true});
        const target = document.querySelector('.chat-input [contenteditable="true"]');
        target?.dispatchEvent(ev);
      }, TINY_PNG_BASE64);
      trace.push({type: 'evaluate', page: pageOf(params.user), script: 'paste tiny PNG via DataTransfer'});
      await u.page.waitForTimeout(500);
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const drag_drop_file_to_chat: IntentDef<z.infer<typeof DragDropFileParams>> = {
  name: 'drag_drop_file_to_chat',
  area: 'media',
  paramsSchema: DragDropFileParams,
  description: 'Drag-drop a file (provided as base64) onto the chat area. Tests drag&drop upload path.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      const dropTarget = u.page.locator('.chat-input, .bubbles-inner').first();
      await dropTarget.evaluate(async(el, args) => {
        const blob = await (await fetch(`data:application/octet-stream;base64,${args.b64}`)).blob();
        const file = new File([blob], args.name, {type: 'application/octet-stream'});
        const dt = new DataTransfer();
        dt.items.add(file);
        const ev = new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true});
        el.dispatchEvent(ev);
      }, {b64: safeBase64(params.contentBase64), name: params.fileName});
      trace.push({type: 'evaluate', page: pageOf(params.user), script: `drag-drop ${params.fileName}`});
      await u.page.waitForTimeout(500);
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const record_voice_message: IntentDef<z.infer<typeof RecordVoiceParams>> = {
  name: 'record_voice_message',
  area: 'media',
  paramsSchema: RecordVoiceParams,
  description: 'Press-and-hold the voice record button for the given duration, then release to send. Tests recorder/voice flow.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      const recordBtn = u.page.locator('.chat-input .btn-record, button[name="record"]').first();
      const box = await recordBtn.boundingBox();
      if(!box) {
        return {ok: false, atomic_trace: trace, observations: [], error: 'voice record button not visible'};
      }
      await u.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await u.page.mouse.down();
      trace.push({type: 'click', page: pageOf(params.user), selector: 'record button (mousedown)'});
      await u.page.waitForTimeout(params.durationMs);
      await u.page.mouse.up();
      trace.push({type: 'click', page: pageOf(params.user), selector: 'record button (mouseup)'});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const mediaIntents: Record<string, IntentDef<any>> = {
  paste_image_to_input: paste_image_to_input as IntentDef<any>,
  drag_drop_file_to_chat: drag_drop_file_to_chat as IntentDef<any>,
  record_voice_message: record_voice_message as IntentDef<any>
};
