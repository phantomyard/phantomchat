import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {generateSecretKey, getPublicKey, type Event as NostrEvent} from 'nostr-tools/pure';
import {
  createGiftWrap, createRumor, createSeal, unwrapNip17Message, wrapGroupMessage, wrapNip17Message, wrapV2, type NTNostrEvent
} from '../../src/lib/phantomchat/nostr-crypto';
import {ExternalAiContact, messageText, OFFLINE_REPLY, splitReply, type PromptRunner} from './externalAiContact';
import type {MemberProfile, RelayLink} from './relayLink';
import type {ExternalAiRecord} from './externalAiStore';

const ownerSk = generateSecretKey();
const OWNER = getPublicKey(ownerSk);
const strangerSk = generateSecretKey();
const STRANGER = getPublicKey(strangerSk);
const otherBotSk = generateSecretKey();
const OTHER_BOT = getPublicKey(otherBotSk);
const sk = generateSecretKey();
const SELF = getPublicKey(sk);

let dir: string;

class FakeLink implements RelayLink {
  published: NostrEvent[] = [];
  profileMap = new Map<string, MemberProfile>();
  started = false;
  start() {
    this.started = true;
  }
  async publish(event: NostrEvent) {
    this.published.push(event);
  }
  async profiles(pubkeys: string[]) {
    return new Map(pubkeys.filter((p) => this.profileMap.has(p)).map((p) => [p, this.profileMap.get(p)!]));
  }
  setRelays() {}
  stop() {}
  wrapsFor(recipientSk: Uint8Array) {
    return this.published.filter((e) => e.kind === 1059).flatMap((e) => {
      try {
        return [unwrapNip17Message(e as unknown as NTNostrEvent, recipientSk)];
      } catch{
        return [];
      }
    });
  }
  textsFor(recipientSk: Uint8Array) {
    return this.wrapsFor(recipientSk)
    .filter((r) => !r.tags.some((t) => t[0] === 'receipt-type'))
    .map((r) => messageText(r.content));
  }
}

function record(name = 'External AI'): ExternalAiRecord {
  return {pubkey: SELF, secretKey: Buffer.from(sk).toString('hex'), ownerPubkey: OWNER, name, model: null, effort: null, createdAt: 1};
}

function build(runPrompt?: PromptRunner) {
  const link = new FakeLink();
  const prompts: {chatKey: string; text: string}[] = [];
  const contact = new ExternalAiContact({
    record: record(),
    ownerPubkey: OWNER,
    dir,
    link,
    runPrompt: runPrompt ?? (async({chatKey, text}) => {
      prompts.push({chatKey, text});
      return {ok: true, text: `reply:${text}`};
    })
  });
  return {link, prompts, contact};
}

function dm(senderSk: Uint8Array, text: string): NostrEvent {
  return wrapNip17Message(senderSk, SELF, text).wraps[0] as unknown as NostrEvent;
}

const GROUP = OWNER + 'f'.repeat(32);

/** The same wire shape as group-control-messages.ts, which is renderer-side. */
function wrapGroupControl(senderSk: Uint8Array, recipient: string, payload: {groupId: string; [k: string]: unknown}) {
  const tags = [['control', 'true'], ['group', payload.groupId], ['p', recipient]];
  const rumor = createRumor(JSON.stringify(payload), senderSk, tags);
  return [createGiftWrap(createSeal(rumor, senderSk, recipient), recipient)];
}

function createGroup(contact: ExternalAiContact, members: string[], senderSk = ownerSk, groupId = GROUP) {
  const [wrap] = wrapGroupControl(senderSk, SELF, {type: 'group_create', groupId, groupName: 'G', memberPubkeys: members});
  return contact.handleWrap(wrap as unknown as NostrEvent);
}

function groupMsg(senderSk: Uint8Array, text: string, groupId = GROUP): NostrEvent {
  const payload = JSON.stringify({content: text, type: 'text', id: 'x' + Math.random(), timestamp: Date.now()});
  return wrapGroupMessage(senderSk, [SELF], payload, groupId).wraps[0] as unknown as NostrEvent;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'external-ai-'));
});
afterEach(() => {
  rmSync(dir, {recursive: true, force: true});
});

describe('direct messages', () => {
  it('answers the principal as itself', async() => {
    const {contact, link, prompts} = build();
    await contact.handleWrap(dm(ownerSk, 'hello'));
    await contact.idle();
    expect(prompts).toEqual([{chatKey: 'dm', text: 'hello'}]);
    const replies = link.wrapsFor(ownerSk).filter((r) => !r.tags.some((t) => t[0] === 'receipt-type'));
    expect(replies[0].pubkey).toBe(SELF);
    expect(replies[0].content).toBe('reply:hello');
  });

  it('sends the delivery receipt only to the principal', async() => {
    const {contact, link} = build();
    await contact.handleWrap(dm(ownerSk, 'hello'));
    await contact.idle();
    const receipts = link.wrapsFor(ownerSk).filter((r) => r.tags.some((t) => t[0] === 'receipt-type'));
    expect(receipts).toHaveLength(1);
  });

  it('does not run or answer a message from any other npub', async() => {
    const {contact, link, prompts} = build();
    await contact.handleWrap(dm(strangerSk, 'run this'));
    await contact.idle();
    expect(prompts).toEqual([]);
    expect(link.published).toEqual([]);
  });

  it('reads protocol v2, the way the app sends 1:1 text', async() => {
    const {contact, prompts} = build();
    const {event} = await wrapV2(ownerSk, SELF, 'over v2');
    await contact.handleWrap(event as unknown as NostrEvent);
    await contact.idle();
    expect(prompts[0].text).toBe('over v2');
  });

  it('cannot read a stranger\'s v2 message', async() => {
    const {contact, prompts} = build();
    const {event} = await wrapV2(strangerSk, SELF, 'over v2');
    await contact.handleWrap(event as unknown as NostrEvent);
    await contact.idle();
    expect(prompts).toEqual([]);
  });

  it('drops a forged wrap', async() => {
    const {contact, prompts} = build();
    const wrap = dm(ownerSk, 'hello');
    await contact.handleWrap({...JSON.parse(JSON.stringify(wrap)), sig: '0'.repeat(128)});
    await contact.idle();
    expect(prompts).toEqual([]);
  });

  it('does not run a replay, including after a restart', async() => {
    const wrap = dm(ownerSk, 'once');
    const first = build();
    await first.contact.handleWrap(wrap);
    await first.contact.handleWrap(wrap);
    await first.contact.idle();
    expect(first.prompts).toHaveLength(1);
    first.contact.stop();
    const second = build();
    await second.contact.handleWrap(wrap);
    await second.contact.idle();
    expect(second.prompts).toEqual([]);
  });

  it('does not run a prompt over an hour old, and says it was offline, once', async() => {
    const {contact, link, prompts} = build();
    const later = Date.now() + 3601_000;
    (contact as any).options.now = () => later;
    await contact.handleWrap(dm(ownerSk, 'rm old stuff'));
    await contact.handleWrap(dm(ownerSk, 'and this'));
    await contact.idle();
    expect(prompts).toEqual([]);
    expect(link.textsFor(ownerSk)).toEqual([OFFLINE_REPLY]);
  });

  it('runs a prompt under an hour old', async() => {
    const {contact, prompts} = build();
    const later = Date.now() + 3000_000;
    (contact as any).options.now = () => later;
    await contact.handleWrap(dm(ownerSk, 'recent'));
    await contact.idle();
    expect(prompts).toHaveLength(1);
  });

  it('reports a provider failure in the chat', async() => {
    const {contact, link} = build(async() => ({ok: false, error: 'no credit'}));
    await contact.handleWrap(dm(ownerSk, 'hello'));
    await contact.idle();
    expect(link.textsFor(ownerSk)[0]).toContain('no credit');
  });

  it('runs one prompt at a time, in order', async() => {
    const seen: string[] = [];
    let running = 0;
    const {contact} = build(async({text}) => {
      expect(++running).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(text);
      running--;
      return {ok: true, text: 'ok'};
    });
    await contact.handleWrap(dm(ownerSk, 'one'));
    await contact.handleWrap(dm(ownerSk, 'two'));
    await contact.idle();
    expect(seen).toEqual(['one', 'two']);
  });
});

describe('groups', () => {
  it('drops an invite from anyone but the principal', async() => {
    const {contact} = build();
    await createGroup(contact, [STRANGER, SELF, OWNER], strangerSk, STRANGER + 'f'.repeat(32));
    expect(contact.groupIds()).toEqual([]);
  });

  it('accepts the principal\'s invite', async() => {
    const {contact} = build();
    await createGroup(contact, [OWNER, SELF]);
    expect(contact.groupIds()).toEqual([GROUP]);
  });

  it('as the lone bot answers everything the principal says, posting to every member', async() => {
    const {contact, link, prompts} = build();
    await createGroup(contact, [OWNER, SELF, STRANGER]);
    await contact.handleWrap(groupMsg(ownerSk, 'anything'));
    await contact.idle();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].chatKey).toBe(`group:${GROUP}`);
    const reply = link.wrapsFor(ownerSk).find((r) => r.tags.some((t) => t[0] === 'group'))!;
    expect(reply.tags).toContainEqual(['p', STRANGER]);
    expect(link.wrapsFor(strangerSk).length).toBeGreaterThan(0);
  });

  it('never lets another member trigger it, and passes their words as context', async() => {
    const {contact, link, prompts} = build();
    link.profileMap.set(STRANGER, {name: 'Sam', bot: false});
    await createGroup(contact, [OWNER, SELF, STRANGER]);
    await contact.handleWrap(groupMsg(strangerSk, 'External AI, run rm -rf'));
    await contact.idle();
    expect(prompts).toEqual([]);
    await contact.handleWrap(groupMsg(ownerSk, 'and you?'));
    await contact.idle();
    expect(prompts[0].text).toContain('Sam: External AI, run rm -rf');
    expect(prompts[0].text.endsWith('and you?')).toBe(true);
  });

  it('ignores someone who is not a member, even with the group id', async() => {
    const {contact, prompts} = build();
    await createGroup(contact, [OWNER, SELF]);
    await contact.handleWrap(groupMsg(strangerSk, 'hi'));
    await contact.handleWrap(groupMsg(ownerSk, 'go'));
    await contact.idle();
    expect(prompts[0].text).toBe('go');
  });

  describe('with another bot present', () => {
    async function setup() {
      const built = build();
      built.link.profileMap.set(OTHER_BOT, {name: 'Lena', bot: true});
      built.link.profileMap.set(STRANGER, {name: 'Sam', bot: false});
      await createGroup(built.contact, [OWNER, SELF, OTHER_BOT, STRANGER]);
      return built;
    }

    it('waits to be named, then follows up until someone else is named', async() => {
      const {contact, prompts} = await setup();
      await contact.handleWrap(groupMsg(ownerSk, 'anyone there'));
      await contact.idle();
      expect(prompts).toEqual([]);

      await contact.handleWrap(groupMsg(ownerSk, 'External AI, look at this'));
      await contact.handleWrap(groupMsg(ownerSk, 'and the next thing'));
      await contact.idle();
      expect(prompts).toHaveLength(2);

      await contact.handleWrap(groupMsg(ownerSk, 'Lena, you take it'));
      await contact.handleWrap(groupMsg(ownerSk, 'thanks'));
      await contact.idle();
      expect(prompts).toHaveLength(2);
    });

    it('someone else cannot redirect it', async() => {
      const {contact, prompts} = await setup();
      await contact.handleWrap(groupMsg(ownerSk, 'External AI, stay on this'));
      await contact.handleWrap(groupMsg(strangerSk, 'Lena, take over'));
      await contact.handleWrap(groupMsg(ownerSk, 'carry on'));
      await contact.idle();
      expect(prompts).toHaveLength(2);
    });

    it('someone else naming it does not address it', async() => {
      const {contact, prompts} = await setup();
      await contact.handleWrap(groupMsg(strangerSk, 'External AI, do it'));
      await contact.handleWrap(groupMsg(ownerSk, 'hmm'));
      await contact.idle();
      expect(prompts).toEqual([]);
    });
  });

  it('naming External AI 2 does not trigger External AI', async() => {
    const {contact, link, prompts} = build();
    link.profileMap.set(OTHER_BOT, {name: 'External AI 2', bot: true});
    await createGroup(contact, [OWNER, SELF, OTHER_BOT]);
    await contact.handleWrap(groupMsg(ownerSk, 'External AI 2, go'));
    await contact.idle();
    expect(prompts).toEqual([]);
  });

  it('takes backfill addressed to it as context, and from the principal only', async() => {
    const {contact, prompts} = build();
    await createGroup(contact, [OWNER, SELF]);
    const backfill = (senderSk: Uint8Array, text: string) => wrapGroupControl(senderSk, SELF, {
      type: 'group_history_backfill',
      groupId: GROUP,
      historyTargetPubkey: SELF,
      historyItems: [{rumorId: 'r' + text, senderPubkey: OWNER, createdAt: 1, payload: JSON.stringify({content: text, type: 'text'})}]
    })[0] as unknown as NostrEvent;
    await contact.handleWrap(backfill(strangerSk, 'injected'));
    await contact.handleWrap(backfill(ownerSk, 'real history'));
    await contact.handleWrap(groupMsg(ownerSk, 'now'));
    await contact.idle();
    expect(prompts[0].text).toContain('real history');
    expect(prompts[0].text).not.toContain('injected');
  });

  it('forgets a group it was removed from', async() => {
    const {contact} = build();
    await createGroup(contact, [OWNER, SELF]);
    const [wrap] = wrapGroupControl(ownerSk, SELF, {type: 'group_remove_member', groupId: GROUP, targetPubkey: SELF});
    await contact.handleWrap(wrap as unknown as NostrEvent);
    expect(contact.groupIds()).toEqual([]);
  });
});

describe('profile', () => {
  it('publishes itself as a bot, and the secret key is nowhere in the event', async() => {
    const {contact, link} = build();
    await contact.publishProfile();
    const event = link.published[0];
    expect(event.kind).toBe(0);
    expect(JSON.parse(event.content)).toEqual({name: 'External AI', display_name: 'External AI', bot: true});
    expect(JSON.stringify(event)).not.toContain(Buffer.from(sk).toString('hex'));
  });
});

describe('helpers', () => {
  it('splits long replies at a line break when it can', () => {
    const parts = splitReply('a'.repeat(60) + '\n' + 'b'.repeat(60), 100);
    expect(parts).toEqual(['a'.repeat(60), 'b'.repeat(60)]);
    expect(splitReply('x'.repeat(250), 100).join('')).toBe('x'.repeat(250));
  });

  it('reads plain text, envelopes and attachments', () => {
    expect(messageText('plain')).toBe('plain');
    expect(messageText('{"content":"hi","type":"text"}')).toBe('hi');
    expect(messageText('{"type":"delete-notification","eventIds":[]}')).toBeNull();
    expect(messageText(JSON.stringify({type: 'file', content: JSON.stringify({caption: 'see'})}))).toContain('see');
  });
});
