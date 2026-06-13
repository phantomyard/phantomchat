import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext, Action} from '../../../src/tests/fuzz/types';
import {sendText, replyToRandomBubble, editRandomOwnBubble, deleteRandomOwnBubble, reactToRandomBubble, removeReaction} from '../../../src/tests/fuzz/actions/messaging';
import {reactViaUI} from '../../../src/tests/fuzz/actions/reactions';

const SendTextParams = z.object({
  from: z.enum(['userA', 'userB']),
  text: z.string().min(1).max(5000)
});

const ReactToMessageParams = z.object({
  from: z.enum(['userA', 'userB']),
  emoji: z.string().min(1).max(8)
});

const ReplyToBubbleParams = z.object({
  from: z.enum(['userA', 'userB']),
  text: z.string().min(1).max(500)
});

const EditOwnBubbleParams = z.object({
  user: z.enum(['userA', 'userB']),
  newText: z.string().min(1).max(500)
});

const DeleteOwnBubbleParams = z.object({
  user: z.enum(['userA', 'userB'])
});

const ReactRandomBubbleParams = z.object({
  user: z.enum(['userA', 'userB']),
  fromTarget: z.enum(['own', 'peer']),
  emoji: z.string().min(1).max(8)
});

const RemoveReactionParams = z.object({
  user: z.enum(['userA', 'userB'])
});

export const send_text_message: IntentDef<z.infer<typeof SendTextParams>> = {
  name: 'send_text_message',
  area: 'messaging',
  paramsSchema: SendTextParams,
  description: 'Send a text message from one user to the other peer.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const action: Action = {name: 'sendText', args: params};
    const synthetic: AtomicAction[] = [
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: '.chat-list peer'},
      {type: 'fill', page: params.from === 'userA' ? 'A' : 'B', selector: '.chat-input [contenteditable="true"]', value: params.text},
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: '.chat-input button.btn-send'}
    ];
    try {
      await sendText.drive(ctx, action);
      return {ok: !action.skipped, atomic_trace: synthetic, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: synthetic, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const react_to_message: IntentDef<z.infer<typeof ReactToMessageParams>> = {
  name: 'react_to_message',
  area: 'messaging',
  paramsSchema: ReactToMessageParams,
  description: 'Add a reaction emoji to the most recent message in the open chat.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const action: Action = {name: 'reactViaUI', args: params};
    const synthetic: AtomicAction[] = [
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: '.bubble:last-child'},
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: '.reactions-menu'},
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: `.reactions-menu emoji[value="${params.emoji}"]`}
    ];
    try {
      await reactViaUI.drive(ctx, action);
      return {ok: !action.skipped, atomic_trace: synthetic, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: synthetic, observations: [], error: err?.message ?? String(err)};
    }
  }
};

const wrapFuzz = <P>(specName: string, spec: any) =>
  async(params: P, ctx: FuzzContext): Promise<IntentResult> => {
    const action: Action = {name: specName, args: params as any};
    try {
      await spec.drive(ctx, action);
      return {ok: !action.skipped, atomic_trace: [], observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: [], observations: [], error: err?.message ?? String(err)};
    }
  };

export const reply_to_bubble: IntentDef<z.infer<typeof ReplyToBubbleParams>> = {
  name: 'reply_to_bubble',
  area: 'messaging',
  paramsSchema: ReplyToBubbleParams,
  description: 'Reply to a randomly selected bubble in the open chat with the given text.',
  exec: wrapFuzz<z.infer<typeof ReplyToBubbleParams>>('replyToRandomBubble', replyToRandomBubble)
};

export const edit_random_own_bubble: IntentDef<z.infer<typeof EditOwnBubbleParams>> = {
  name: 'edit_random_own_bubble',
  area: 'messaging',
  paramsSchema: EditOwnBubbleParams,
  description: 'Edit a randomly selected own (sent-by-user) bubble to the given new text.',
  exec: wrapFuzz<z.infer<typeof EditOwnBubbleParams>>('editRandomOwnBubble', editRandomOwnBubble)
};

export const delete_random_own_bubble: IntentDef<z.infer<typeof DeleteOwnBubbleParams>> = {
  name: 'delete_random_own_bubble',
  area: 'messaging',
  paramsSchema: DeleteOwnBubbleParams,
  description: 'Delete a randomly selected own bubble (delete-for-self).',
  exec: wrapFuzz<z.infer<typeof DeleteOwnBubbleParams>>('deleteRandomOwnBubble', deleteRandomOwnBubble)
};

export const react_to_random_bubble: IntentDef<z.infer<typeof ReactRandomBubbleParams>> = {
  name: 'react_to_random_bubble',
  area: 'messaging',
  paramsSchema: ReactRandomBubbleParams,
  description: 'Add a reaction emoji to a randomly selected bubble.',
  exec: wrapFuzz<z.infer<typeof ReactRandomBubbleParams>>('reactToRandomBubble', reactToRandomBubble)
};

export const remove_reaction: IntentDef<z.infer<typeof RemoveReactionParams>> = {
  name: 'remove_reaction',
  area: 'messaging',
  paramsSchema: RemoveReactionParams,
  description: 'Remove a reaction the user previously added to any bubble.',
  exec: wrapFuzz<z.infer<typeof RemoveReactionParams>>('removeReaction', removeReaction)
};

export const messagingIntents: Record<string, IntentDef<any>> = {
  send_text_message: send_text_message as IntentDef<any>,
  react_to_message: react_to_message as IntentDef<any>,
  reply_to_bubble: reply_to_bubble as IntentDef<any>,
  edit_random_own_bubble: edit_random_own_bubble as IntentDef<any>,
  delete_random_own_bubble: delete_random_own_bubble as IntentDef<any>,
  react_to_random_bubble: react_to_random_bubble as IntentDef<any>,
  remove_reaction: remove_reaction as IntentDef<any>
};
