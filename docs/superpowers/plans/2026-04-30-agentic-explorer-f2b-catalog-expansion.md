# Agentic Explorer — F2b Catalog Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Expand the F1 intent catalog (6 intents) by ~15 new intents covering the four Q2-priority surfaces: media & input (paste, drag&drop, voice), edge of messaging already fuzzed (forward, pin, delete-for-everyone, search, deep scroll), network/offline (toggle offline, slow network, disconnect relay), and profile advanced (avatar, lightning, NIP-65 relays). Plus 2-3 bubble manipulation intents wrapped from existing fuzz actions (reply_to_bubble, edit_random_own_bubble, delete_random_own_bubble).

**Architecture:** Each new intent is an `IntentDef` registered in the appropriate `scripts/explorer/intents/<area>.ts` module. Intents that wrap existing fuzz `ActionSpec`s (e.g. `replyToRandomBubble`, `editRandomOwnBubble`, `deleteRandomOwnBubble` from `messaging.ts`) reuse via `spec.drive(ctx, action)`. Intents with no fuzz equivalent (paste, drag, voice, theme toggle, etc.) implement Playwright UI flows directly inside the intent's `exec` function. The registry merges all area modules.

**Tech Stack:** TypeScript 5.7, Playwright 1.59, Vitest 0.34, Zod 3.23. No new runtime dependencies.

**Phase scope:** F2b only — catalog expansion. F2c (autonomous loop wiring + Oracle D + triage dispatch) is a separate plan.

**Verification at end of F2b:**
- `intents.test.ts` field-shape iteration passes over ~21 intents (6 F1 + ~15 new)
- Each new intent has its params Zod-schema validated by tests in `intents.test.ts`
- No NEW lint/tsc errors beyond baseline
- Manual smoke (user-driven, NOT in the plan): /nostra-explore "edit profile" with the existing F1 subagent should still work — F2b does NOT change subagent dispatch logic

---

## File structure

### New files

```
scripts/explorer/intents/
├── media.ts                 # paste_image_to_input, drag_drop_file_to_chat, record_voice_message
├── messaging-edge.ts        # forward_message, pin_message, delete_for_everyone, search_in_chat, deep_scroll
├── network.ts               # toggle_offline, slow_network, disconnect_relay, reconnect_relay
└── settings.ts              # toggle_theme, set_language
```

### Modified files

```
scripts/explorer/intents/messaging.ts    # add: reply_to_bubble, edit_random_own_bubble, delete_random_own_bubble (wrap fuzz)
scripts/explorer/intents/profile.ts      # add: upload_avatar, configure_lightning, edit_relays_nip65
scripts/explorer/intents/registry.ts     # import + spread all 4 new modules
src/tests/explorer/intents.test.ts       # update minimum-count assertion ≥ 20
```

---

## Phase F2b: Catalog Expansion

### Task 1: Bubble manipulation intents (wrap fuzz actions)

**Why:** F1 only wraps `sendText` and `reactViaUI` from messaging.ts. The fuzz already has `replyToRandomBubble`, `editRandomOwnBubble`, `deleteRandomOwnBubble`, `removeReaction`, `reactToRandomBubble`. Wrap them all into intents — minimal effort, high coverage value.

**Files:**
- Modify: `scripts/explorer/intents/messaging.ts`

- [ ] **Step 1: Inspect existing fuzz exports**

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a
grep -nE "^export const " src/tests/fuzz/actions/messaging.ts
```

Expected exports: `sendText`, `replyToRandomBubble`, `editRandomOwnBubble`, `deleteRandomOwnBubble`, `reactToRandomBubble`, `removeReaction`, `reactMultipleEmoji`.

- [ ] **Step 2: Extend `messaging.ts` with 5 new intents**

Open `scripts/explorer/intents/messaging.ts`. Keep the existing `send_text_message` and `react_to_message` intact. Add these 5 new intents and register them in `messagingIntents`:

```typescript
import {
  sendText,
  replyToRandomBubble,
  editRandomOwnBubble,
  deleteRandomOwnBubble,
  reactToRandomBubble,
  removeReaction
} from '../../../src/tests/fuzz/actions/messaging';
import {reactViaUI} from '../../../src/tests/fuzz/actions/reactions';

// ... existing send_text_message, react_to_message stay ...

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
  emoji: z.string().min(1).max(8)
});

const RemoveReactionParams = z.object({
  user: z.enum(['userA', 'userB'])
});

const wrapFuzz = (specName: string, spec: any, paramsToArgs: (p: any) => any) => async(params: any, ctx: FuzzContext): Promise<IntentResult> => {
  const action: Action = {name: specName, args: paramsToArgs(params)};
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
  exec: wrapFuzz('replyToRandomBubble', replyToRandomBubble, (p) => p)
};

export const edit_random_own_bubble: IntentDef<z.infer<typeof EditOwnBubbleParams>> = {
  name: 'edit_random_own_bubble',
  area: 'messaging',
  paramsSchema: EditOwnBubbleParams,
  description: 'Edit a randomly selected own (sent-by-user) bubble to the given new text.',
  exec: wrapFuzz('editRandomOwnBubble', editRandomOwnBubble, (p) => p)
};

export const delete_random_own_bubble: IntentDef<z.infer<typeof DeleteOwnBubbleParams>> = {
  name: 'delete_random_own_bubble',
  area: 'messaging',
  paramsSchema: DeleteOwnBubbleParams,
  description: 'Delete a randomly selected own bubble (delete-for-self).',
  exec: wrapFuzz('deleteRandomOwnBubble', deleteRandomOwnBubble, (p) => p)
};

export const react_to_random_bubble: IntentDef<z.infer<typeof ReactRandomBubbleParams>> = {
  name: 'react_to_random_bubble',
  area: 'messaging',
  paramsSchema: ReactRandomBubbleParams,
  description: 'Add a reaction emoji to a randomly selected bubble (any sender).',
  exec: wrapFuzz('reactToRandomBubble', reactToRandomBubble, (p) => p)
};

export const remove_reaction: IntentDef<z.infer<typeof RemoveReactionParams>> = {
  name: 'remove_reaction',
  area: 'messaging',
  paramsSchema: RemoveReactionParams,
  description: 'Remove a reaction the user previously added to any bubble.',
  exec: wrapFuzz('removeReaction', removeReaction, (p) => p)
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
```

NOTE: confirm the actual fuzz `ActionSpec.generateArgs` shape for each — specifically: `replyToRandomBubble` takes `{from, text}`; `editRandomOwnBubble` takes `{user, newText}`; `deleteRandomOwnBubble` takes `{user}`; `reactToRandomBubble` takes `{user, emoji}`; `removeReaction` takes `{user}`. If any deviates, adjust the param schema accordingly.

- [ ] **Step 3: Verify tests still pass**

```bash
pnpm exec vitest run src/tests/explorer/intents.test.ts
```
Expected: 2/2 — the field-shape iteration now goes over 7 intents (was 2 in F1).

- [ ] **Step 4: Lint clean**

```bash
npx eslint scripts/explorer/intents/messaging.ts
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/explorer/intents/messaging.ts
git commit -m "$(cat <<'EOF'
feat(explorer): bubble manipulation intents (reply, edit, delete, react, remove)

Wraps existing fuzz ActionSpecs from messaging.ts/reactions.ts into the
intent catalog: reply_to_bubble, edit_random_own_bubble,
delete_random_own_bubble, react_to_random_bubble, remove_reaction.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Profile advanced intents (avatar, lightning, NIP-65 relays)

**Files:**
- Modify: `scripts/explorer/intents/profile.ts`

The fuzz has `uploadAvatarAction` already. Lightning and NIP-65 relay editing are not in the fuzz catalog yet — implement Playwright flows directly using selectors that match the current settings UI.

- [ ] **Step 1: Identify the settings UI selectors**

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a
grep -rE "lightning.*address|lightning_address|lud16" src/components/sidebarLeft/tabs/ 2>/dev/null | head -5
grep -rE "relay.*list|relayList|nip-?65" src/components/sidebarLeft/tabs/ 2>/dev/null | head -5
```

If you find an obvious selector path, use it in the intent. Otherwise, use generic `getByRole`/`getByText` matchers — the F1 selector-resolver chain handles fallback.

- [ ] **Step 2: Extend `profile.ts`**

Add to `scripts/explorer/intents/profile.ts` (keep existing `edit_profile_field` intact):

```typescript
import {uploadAvatarAction} from '../../../src/tests/fuzz/actions/profile';

const UploadAvatarParams = z.object({
  user: z.enum(['userA', 'userB']),
  size: z.number().int().min(16).max(256)
});

const ConfigureLightningParams = z.object({
  user: z.enum(['userA', 'userB']),
  address: z.string().min(3).max(80)  // e.g. user@domain.com
});

const EditRelaysParams = z.object({
  user: z.enum(['userA', 'userB']),
  add: z.array(z.string().url()).max(10),
  remove: z.array(z.string().url()).max(10)
});

export const upload_avatar: IntentDef<z.infer<typeof UploadAvatarParams>> = {
  name: 'upload_avatar',
  area: 'profile',
  paramsSchema: UploadAvatarParams,
  description: 'Upload a generated avatar image of the given size to the user\'s profile.',
  async exec(params, ctx) {
    const action: Action = {name: 'uploadAvatarAction', args: params};
    const trace: AtomicAction[] = [
      {type: 'click', page: pageOf(params.user), selector: '.avatar-edit-btn'},
      {type: 'evaluate', page: pageOf(params.user), script: '/* upload generated image */'}
    ];
    try {
      await uploadAvatarAction.drive(ctx, action);
      return {ok: !action.skipped, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const configure_lightning_address: IntentDef<z.infer<typeof ConfigureLightningParams>> = {
  name: 'configure_lightning_address',
  area: 'profile',
  paramsSchema: ConfigureLightningParams,
  description: 'Open profile settings, set the Lightning address (lud16) to the given value, save.',
  async exec(params, ctx) {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      // Open settings
      await u.page.locator('.sidebar-header .btn-menu-toggle').first().click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'menu-toggle'});
      await u.page.getByText('Settings', {exact: false}).first().click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'menu Settings'});
      // Find Lightning input — fallback chain for various layouts
      const inputCandidates = [
        u.page.locator('[name="lud16"]').first(),
        u.page.locator('[name="lightning_address"]').first(),
        u.page.getByRole('textbox', {name: /lightning|lud16/i}).first()
      ];
      let filled = false;
      for(const c of inputCandidates) {
        const visible = await c.isVisible().catch(() => false);
        if(visible) {
          await c.fill(params.address);
          trace.push({type: 'fill', page: pageOf(params.user), selector: 'lightning input', value: params.address});
          filled = true;
          break;
        }
      }
      if(!filled) {
        return {ok: false, atomic_trace: trace, observations: [], error: 'lightning address input not found'};
      }
      // Save
      const saveBtn = u.page.getByRole('button', {name: /save/i}).first();
      await saveBtn.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'save'});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const edit_relays_nip65: IntentDef<z.infer<typeof EditRelaysParams>> = {
  name: 'edit_relays_nip65',
  area: 'profile',
  paramsSchema: EditRelaysParams,
  description: 'Open relay settings, add/remove relays in the user\'s NIP-65 relay list, save.',
  async exec(params, ctx) {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await u.page.locator('.sidebar-header .btn-menu-toggle').first().click({timeout: 3000});
      await u.page.getByText('Settings', {exact: false}).first().click({timeout: 3000});
      const relaysItem = u.page.getByText(/relay/i).first();
      await relaysItem.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'relays settings'});
      // Add new relays
      for(const url of params.add) {
        const input = u.page.getByRole('textbox', {name: /add.*relay|relay.*url/i}).first();
        if(await input.isVisible().catch(() => false)) {
          await input.fill(url);
          await u.page.keyboard.press('Enter');
          trace.push({type: 'fill', page: pageOf(params.user), selector: 'relay input', value: url});
        }
      }
      // Remove relays
      for(const url of params.remove) {
        const removeBtn = u.page.locator(`[data-relay-url="${url}"] .btn-remove, [data-relay="${url}"] button[name="remove"]`).first();
        if(await removeBtn.isVisible().catch(() => false)) {
          await removeBtn.click({timeout: 1000});
          trace.push({type: 'click', page: pageOf(params.user), selector: `remove ${url}`});
        }
      }
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const profileIntents: Record<string, IntentDef<any>> = {
  edit_profile_field: edit_profile_field as IntentDef<any>,
  upload_avatar: upload_avatar as IntentDef<any>,
  configure_lightning_address: configure_lightning_address as IntentDef<any>,
  edit_relays_nip65: edit_relays_nip65 as IntentDef<any>
};
```

- [ ] **Step 3: Verify tests + lint**

```bash
pnpm exec vitest run src/tests/explorer/intents.test.ts
npx eslint scripts/explorer/intents/profile.ts
```
Expected: 2/2 tests pass (now over 10 intents); lint 0 errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/explorer/intents/profile.ts
git commit -m "$(cat <<'EOF'
feat(explorer): profile advanced intents (avatar, lightning, NIP-65 relays)

Adds upload_avatar (wraps fuzz uploadAvatarAction),
configure_lightning_address (direct UI flow with lud16 selector
fallback chain), and edit_relays_nip65 (open relays settings,
add/remove URLs in NIP-65 list).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Edge messaging intents (forward, pin, delete-for-everyone, search, deep scroll)

**Files:**
- Create: `scripts/explorer/intents/messaging-edge.ts`

These have no fuzz equivalents — implement Playwright flows directly using context-menu interactions on bubbles.

- [ ] **Step 1: Implement messaging-edge.ts**

Create `scripts/explorer/intents/messaging-edge.ts`:

```typescript
import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext} from '../../../src/tests/fuzz/types';

const ForwardMessageParams = z.object({
  from: z.enum(['userA', 'userB']),
  toPeer: z.string()  // peer name or pubkey hex
});

const PinMessageParams = z.object({
  user: z.enum(['userA', 'userB'])
});

const DeleteForEveryoneParams = z.object({
  user: z.enum(['userA', 'userB'])
});

const SearchInChatParams = z.object({
  user: z.enum(['userA', 'userB']),
  query: z.string().min(1).max(100)
});

const DeepScrollParams = z.object({
  user: z.enum(['userA', 'userB']),
  totalScrolls: z.number().int().min(1).max(200)
});

const pageOf = (u: 'userA'|'userB'): 'A'|'B' => u === 'userA' ? 'A' : 'B';

async function rightClickRandomBubble(page: any, ownOnly: boolean) {
  const selector = ownOnly
    ? '.bubbles-inner .bubble[data-mid].is-out, .bubbles-inner .bubble[data-mid].is-own'
    : '.bubbles-inner .bubble[data-mid]';
  const bubble = page.locator(selector).filter({hasNot: page.locator('.is-sending, .is-outgoing')}).last();
  await bubble.click({button: 'right', timeout: 3000});
}

export const forward_message: IntentDef<z.infer<typeof ForwardMessageParams>> = {
  name: 'forward_message',
  area: 'edge',
  paramsSchema: ForwardMessageParams,
  description: 'Right-click a bubble, choose Forward, select target peer from the picker.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.from];
    const trace: AtomicAction[] = [];
    try {
      await rightClickRandomBubble(u.page, false);
      trace.push({type: 'click', page: pageOf(params.from), selector: 'bubble (right-click)'});
      const forwardBtn = u.page.getByRole('menuitem', {name: /forward/i}).or(u.page.getByText(/forward/i)).first();
      await forwardBtn.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.from), selector: 'menu Forward'});
      const peerOpt = u.page.getByText(params.toPeer, {exact: false}).first();
      await peerOpt.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.from), selector: `peer ${params.toPeer}`});
      const sendBtn = u.page.getByRole('button', {name: /send|forward/i}).first();
      await sendBtn.click({timeout: 3000});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const pin_message: IntentDef<z.infer<typeof PinMessageParams>> = {
  name: 'pin_message',
  area: 'edge',
  paramsSchema: PinMessageParams,
  description: 'Right-click a bubble and pin it.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await rightClickRandomBubble(u.page, false);
      trace.push({type: 'click', page: pageOf(params.user), selector: 'bubble (right-click)'});
      const pinBtn = u.page.getByRole('menuitem', {name: /^pin/i}).or(u.page.getByText(/^pin/i)).first();
      await pinBtn.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'menu Pin'});
      // Confirm if dialog appears
      const confirmBtn = u.page.getByRole('button', {name: /^pin|confirm|ok/i}).first();
      if(await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click({timeout: 1000});
      }
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const delete_for_everyone: IntentDef<z.infer<typeof DeleteForEveryoneParams>> = {
  name: 'delete_for_everyone',
  area: 'edge',
  paramsSchema: DeleteForEveryoneParams,
  description: 'Right-click a user-owned bubble, choose Delete, then check "for everyone" if available.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await rightClickRandomBubble(u.page, true);
      trace.push({type: 'click', page: pageOf(params.user), selector: 'own bubble (right-click)'});
      const delBtn = u.page.getByRole('menuitem', {name: /^delete/i}).or(u.page.getByText(/^delete/i)).first();
      await delBtn.click({timeout: 3000});
      const forEveryone = u.page.getByLabel(/everyone|all/i).first();
      if(await forEveryone.isVisible().catch(() => false)) {
        await forEveryone.check({timeout: 1000});
        trace.push({type: 'click', page: pageOf(params.user), selector: 'for everyone checkbox'});
      }
      const confirmBtn = u.page.getByRole('button', {name: /^delete|confirm|ok/i}).first();
      await confirmBtn.click({timeout: 3000});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const search_in_chat: IntentDef<z.infer<typeof SearchInChatParams>> = {
  name: 'search_in_chat',
  area: 'edge',
  paramsSchema: SearchInChatParams,
  description: 'Open the in-chat search and type a query.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      const searchBtn = u.page.locator('.chat-info .btn-search, [data-testid="search-in-chat"]').first();
      if(await searchBtn.isVisible().catch(() => false)) {
        await searchBtn.click({timeout: 3000});
        trace.push({type: 'click', page: pageOf(params.user), selector: 'search button'});
      } else {
        // Fallback: keyboard shortcut Ctrl+F (if supported)
        await u.page.keyboard.press('Control+F');
      }
      const searchInput = u.page.locator('.chat-search input, input[placeholder*="search" i]').first();
      await searchInput.fill(params.query);
      trace.push({type: 'fill', page: pageOf(params.user), selector: 'search input', value: params.query});
      await u.page.waitForTimeout(500);
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const deep_scroll: IntentDef<z.infer<typeof DeepScrollParams>> = {
  name: 'deep_scroll',
  area: 'edge',
  paramsSchema: DeepScrollParams,
  description: 'Scroll the open chat backwards aggressively (more than scroll_history_back) — exercises history loading at depth.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      const container = u.page.locator('.bubbles-inner, .chat-bubbles').first();
      for(let i = 0; i < params.totalScrolls; i++) {
        await container.evaluate((el) => {(el as HTMLElement).scrollTop -= 1500;});
        await u.page.waitForTimeout(60);
      }
      trace.push({type: 'evaluate', page: pageOf(params.user), script: `${params.totalScrolls} scroll iterations`});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const messagingEdgeIntents: Record<string, IntentDef<any>> = {
  forward_message: forward_message as IntentDef<any>,
  pin_message: pin_message as IntentDef<any>,
  delete_for_everyone: delete_for_everyone as IntentDef<any>,
  search_in_chat: search_in_chat as IntentDef<any>,
  deep_scroll: deep_scroll as IntentDef<any>
};
```

- [ ] **Step 2: Add to registry**

In `scripts/explorer/intents/registry.ts`:

```typescript
import {messagingEdgeIntents} from './messaging-edge';

export const registry: Record<string, IntentDef<any>> = {
  ...messagingIntents,
  ...navigationIntents,
  ...profileIntents,
  ...messagingEdgeIntents
};
```

- [ ] **Step 3: Verify tests + lint**

```bash
pnpm exec vitest run src/tests/explorer/intents.test.ts
npx eslint scripts/explorer/intents/messaging-edge.ts scripts/explorer/intents/registry.ts
```

- [ ] **Step 4: Commit**

```bash
git add scripts/explorer/intents/messaging-edge.ts scripts/explorer/intents/registry.ts
git commit -m "$(cat <<'EOF'
feat(explorer): edge messaging intents (forward, pin, delete-for-everyone, search, deep_scroll)

5 new intents covering bubble context-menu actions and in-chat search.
Direct Playwright flows since these have no fuzz ActionSpec equivalents.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Network / offline intents

**Files:**
- Create: `scripts/explorer/intents/network.ts`

Uses Playwright's `context.setOffline(true)` and route-throttling primitives. The fuzz harness exposes `ctx.users[userId].context` for direct context manipulation.

- [ ] **Step 1: Implement network.ts**

```typescript
import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext} from '../../../src/tests/fuzz/types';

const ToggleOfflineParams = z.object({
  user: z.enum(['userA', 'userB']),
  offline: z.boolean()
});

const SlowNetworkParams = z.object({
  user: z.enum(['userA', 'userB']),
  downloadKbps: z.number().int().min(1).max(10_000),
  uploadKbps: z.number().int().min(1).max(10_000)
});

const RelayUrlParams = z.object({
  user: z.enum(['userA', 'userB']),
  relayUrl: z.string().min(5)
});

const pageOf = (u: 'userA'|'userB'): 'A'|'B' => u === 'userA' ? 'A' : 'B';

export const toggle_offline: IntentDef<z.infer<typeof ToggleOfflineParams>> = {
  name: 'toggle_offline',
  area: 'network',
  paramsSchema: ToggleOfflineParams,
  description: 'Set the user\'s browser context to offline (true) or online (false). Tests offline-queue behavior + reconnect.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    try {
      await ctx.users[params.user].context.setOffline(params.offline);
      return {
        ok: true,
        atomic_trace: [{type: 'evaluate', page: pageOf(params.user), script: `context.setOffline(${params.offline})`}],
        observations: []
      };
    } catch(err: any) {
      return {ok: false, atomic_trace: [], observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const slow_network: IntentDef<z.infer<typeof SlowNetworkParams>> = {
  name: 'slow_network',
  area: 'network',
  paramsSchema: SlowNetworkParams,
  description: 'Throttle the user\'s context bandwidth via CDP. Tests slow-connection behavior.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    try {
      const cdp = await ctx.users[params.user].context.newCDPSession(ctx.users[params.user].page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 100,
        downloadThroughput: (params.downloadKbps * 1024) / 8,
        uploadThroughput: (params.uploadKbps * 1024) / 8
      });
      return {
        ok: true,
        atomic_trace: [{type: 'evaluate', page: pageOf(params.user), script: `CDP throttle ${params.downloadKbps}/${params.uploadKbps} kbps`}],
        observations: []
      };
    } catch(err: any) {
      return {ok: false, atomic_trace: [], observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const disconnect_relay: IntentDef<z.infer<typeof RelayUrlParams>> = {
  name: 'disconnect_relay',
  area: 'network',
  paramsSchema: RelayUrlParams,
  description: 'Block a specific relay URL via Playwright route. Tests relay-drop recovery.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    try {
      await ctx.users[params.user].context.route(`**/${params.relayUrl}/**`, (route) => route.abort('connectionrefused'));
      return {
        ok: true,
        atomic_trace: [{type: 'evaluate', page: pageOf(params.user), script: `block ${params.relayUrl}`}],
        observations: []
      };
    } catch(err: any) {
      return {ok: false, atomic_trace: [], observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const reconnect_relay: IntentDef<z.infer<typeof RelayUrlParams>> = {
  name: 'reconnect_relay',
  area: 'network',
  paramsSchema: RelayUrlParams,
  description: 'Unblock a previously blocked relay URL.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    try {
      await ctx.users[params.user].context.unroute(`**/${params.relayUrl}/**`);
      return {
        ok: true,
        atomic_trace: [{type: 'evaluate', page: pageOf(params.user), script: `unblock ${params.relayUrl}`}],
        observations: []
      };
    } catch(err: any) {
      return {ok: false, atomic_trace: [], observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const networkIntents: Record<string, IntentDef<any>> = {
  toggle_offline: toggle_offline as IntentDef<any>,
  slow_network: slow_network as IntentDef<any>,
  disconnect_relay: disconnect_relay as IntentDef<any>,
  reconnect_relay: reconnect_relay as IntentDef<any>
};
```

- [ ] **Step 2: Add to registry**

```typescript
import {networkIntents} from './network';
// ...
export const registry: Record<string, IntentDef<any>> = {
  ...messagingIntents,
  ...navigationIntents,
  ...profileIntents,
  ...messagingEdgeIntents,
  ...networkIntents
};
```

- [ ] **Step 3: Verify tests + lint, commit**

```bash
pnpm exec vitest run src/tests/explorer/intents.test.ts
npx eslint scripts/explorer/intents/network.ts scripts/explorer/intents/registry.ts
git add scripts/explorer/intents/network.ts scripts/explorer/intents/registry.ts
git commit -m "$(cat <<'EOF'
feat(explorer): network/offline intents (toggle_offline, slow_network, disconnect_relay, reconnect_relay)

Uses Playwright context.setOffline() + CDP Network.emulateNetworkConditions
+ context.route() to simulate offline / slow / blocked-relay scenarios.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Settings intents (theme, language)

**Files:**
- Create: `scripts/explorer/intents/settings.ts`

- [ ] **Step 1: Implement settings.ts**

```typescript
import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext} from '../../../src/tests/fuzz/types';

const ToggleThemeParams = z.object({
  user: z.enum(['userA', 'userB'])
});

const SetLanguageParams = z.object({
  user: z.enum(['userA', 'userB']),
  langCode: z.enum(['en', 'it', 'es', 'fr', 'de', 'pt', 'ru'])
});

const pageOf = (u: 'userA'|'userB'): 'A'|'B' => u === 'userA' ? 'A' : 'B';

async function openSettings(page: any) {
  await page.locator('.sidebar-header .btn-menu-toggle').first().click({timeout: 3000});
  await page.getByText('Settings', {exact: false}).first().click({timeout: 3000});
}

export const toggle_theme: IntentDef<z.infer<typeof ToggleThemeParams>> = {
  name: 'toggle_theme',
  area: 'settings',
  paramsSchema: ToggleThemeParams,
  description: 'Toggle between light and dark theme via the appearance settings.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await openSettings(u.page);
      const appearanceItem = u.page.getByText(/appearance|theme/i).first();
      await appearanceItem.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'Appearance'});
      const toggleBtn = u.page.getByRole('button', {name: /dark|light/i}).first()
        .or(u.page.locator('input[type="checkbox"][name="theme"]').first());
      await toggleBtn.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'theme toggle'});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const set_language: IntentDef<z.infer<typeof SetLanguageParams>> = {
  name: 'set_language',
  area: 'settings',
  paramsSchema: SetLanguageParams,
  description: 'Change the UI language to the given language code.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.user];
    const trace: AtomicAction[] = [];
    try {
      await openSettings(u.page);
      const langItem = u.page.getByText(/language/i).first();
      await langItem.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: 'Language'});
      const langOption = u.page.locator(`[data-lang="${params.langCode}"]`).first()
        .or(u.page.getByText(new RegExp(`\\b${params.langCode}\\b`, 'i')).first());
      await langOption.click({timeout: 3000});
      trace.push({type: 'click', page: pageOf(params.user), selector: `lang ${params.langCode}`});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const settingsIntents: Record<string, IntentDef<any>> = {
  toggle_theme: toggle_theme as IntentDef<any>,
  set_language: set_language as IntentDef<any>
};
```

- [ ] **Step 2: Add to registry, test, lint, commit**

```typescript
import {settingsIntents} from './settings';
// ...
export const registry: Record<string, IntentDef<any>> = {
  ...messagingIntents, ...navigationIntents, ...profileIntents,
  ...messagingEdgeIntents, ...networkIntents, ...settingsIntents
};
```

```bash
pnpm exec vitest run src/tests/explorer/intents.test.ts
npx eslint scripts/explorer/intents/settings.ts scripts/explorer/intents/registry.ts
git add scripts/explorer/intents/settings.ts scripts/explorer/intents/registry.ts
git commit -m "$(cat <<'EOF'
feat(explorer): settings intents (toggle_theme, set_language)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Media intents (paste image, drag&drop file, voice message)

**Files:**
- Create: `scripts/explorer/intents/media.ts`

These use Playwright's clipboard / fileChooser / drag-drop APIs. Most exercises real upload paths through Blossom.

- [ ] **Step 1: Implement media.ts**

```typescript
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
      // Inject DataTransfer with image, dispatch paste
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
      }, {b64: params.contentBase64, name: params.fileName});
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
```

- [ ] **Step 2: Add to registry, test, lint, commit**

```typescript
import {mediaIntents} from './media';
// ...
export const registry: Record<string, IntentDef<any>> = {
  ...messagingIntents, ...navigationIntents, ...profileIntents,
  ...messagingEdgeIntents, ...networkIntents, ...settingsIntents,
  ...mediaIntents
};
```

```bash
pnpm exec vitest run src/tests/explorer/intents.test.ts
npx eslint scripts/explorer/intents/media.ts scripts/explorer/intents/registry.ts
git add scripts/explorer/intents/media.ts scripts/explorer/intents/registry.ts
git commit -m "$(cat <<'EOF'
feat(explorer): media intents (paste_image, drag_drop_file, record_voice)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: F2b milestone — verify catalog + commit

- [ ] **Step 1: Tighten the intents.test.ts assertion**

The F1 plan replaced the catalog-non-empty assertion with a typeof-object check. Now that we have ~21 intents, restore a stronger assertion. Edit `src/tests/explorer/intents.test.ts`:

Replace:
```typescript
  it('returns an object (catalog grows in subsequent tasks)', () => {
    expect(typeof registry).toBe('object');
  });
```

With:
```typescript
  it('catalog has at least 20 intents covering all 7 areas', () => {
    const names = Object.keys(registry);
    expect(names.length).toBeGreaterThanOrEqual(20);
    const areas = new Set(Object.values(registry).map((d) => d.area));
    // All 7 spec areas should be represented in F2b
    expect(areas).toContain('messaging');
    expect(areas).toContain('navigation');
    expect(areas).toContain('profile');
    expect(areas).toContain('edge');
    expect(areas).toContain('network');
    expect(areas).toContain('settings');
    expect(areas).toContain('media');
  });
```

- [ ] **Step 2: Verify all unit tests still pass**

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a
pnpm exec vitest run src/tests/explorer/ipc.test.ts src/tests/explorer/intents.test.ts src/tests/explorer/selector-resolver.test.ts src/tests/explorer/oracle-hard.test.ts src/tests/explorer/reporter.test.ts src/tests/explorer/replay.test.ts src/tests/explorer/socket-client.test.ts src/tests/explorer/signature.test.ts src/tests/explorer/reporter-error.test.ts src/tests/explorer/expectations.test.ts > /tmp/f2b-tests.log 2>&1
grep '"success":' /tmp/f2b-tests.log | head -1
grep -E '"numTotalTests":|"numPassedTests":|"numFailedTests":' /tmp/f2b-tests.log
```

Expected: `success: true`, all tests pass, total ~30 (the catalog count change doesn't add new test cases, but the existing iteration tests now cover ~21 intents).

- [ ] **Step 3: Lint clean across all modified/new intent files**

```bash
npx eslint scripts/explorer/intents/messaging.ts scripts/explorer/intents/profile.ts \
  scripts/explorer/intents/messaging-edge.ts scripts/explorer/intents/network.ts \
  scripts/explorer/intents/settings.ts scripts/explorer/intents/media.ts \
  scripts/explorer/intents/registry.ts src/tests/explorer/intents.test.ts
```

Expected: 0 errors.

- [ ] **Step 4: Optional milestone commit**

```bash
git add src/tests/explorer/intents.test.ts
git commit -m "$(cat <<'EOF'
test(explorer): tighten intent catalog assertion (≥20 intents, 7 areas)

Reverts the F1 placeholder check now that F2b has populated the catalog
across all 7 spec areas (messaging, navigation, profile, edge, network,
settings, media).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Out of scope for F2b (explicit)

- Oracle D LLM-generated invariants — F2c
- Triage subagent dispatch wiring — F2c
- Autonomous LLM-driven loop — F2c
- Per-step expectation declaration in subagent prompt — F2c
- Auto-fix pipeline — F3
- Testing each intent end-to-end against running dev server — out of scope (F1 deferred this; same pattern)

F2b deliberately does NOT change the subagent flow. The F1 single-intent flow continues to work; F2c will replace the subagent prompt to use the autonomous loop.
