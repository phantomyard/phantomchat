/*
 * Who should answer in a group (issue #276).
 *
 * The same rules as a phantombot phantom, minus one thing: only the principal
 * can trigger an External AI. The caller runs this for the principal's messages
 * only, so someone else's message can never trigger it or change who was last
 * addressed.
 *
 *  - No other bot in the group: answer everything.
 *  - Another bot present: answer when named, then keep answering unnamed
 *    follow-ups until the principal names someone else.
 */

export interface RosterEntry {
  pubkey: string;
  name: string;
}

const NAME_CHAR = /[\p{L}\p{N}]/u;
const ESCAPE = /[.*+?^${}()|[\]\\]/g;

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Pubkeys named in `text`, in roster order. Longest name wins, so "External AI 2"
 * never also counts as "External AI", even when both are on the roster. A name
 * followed by a bare number is a different name, which also covers a sibling
 * whose profile has not resolved yet.
 */
export function matchRosterNames(text: string, roster: RosterEntry[]): string[] {
  if(!text) return [];
  let haystack = text.toLowerCase();
  const matched = new Set<string>();
  const byLength = roster
  .filter((entry) => normalize(entry.name))
  .sort((a, b) => normalize(b.name).length - normalize(a.name).length);

  for(const entry of byLength) {
    const needle = normalize(entry.name).replace(ESCAPE, '\\$&').replace(/\s+/g, '\\s+');
    const pattern = new RegExp(needle + '(?!\\s+\\d+(?![\\p{L}\\p{N}]))', 'gu');
    let found = false;
    haystack = haystack.replace(pattern, (match, offset: number, whole: string) => {
      const before = whole.slice(0, offset);
      const after = whole.slice(offset + match.length);
      const beforeChar = [...before].pop() ?? '';
      const afterChar = [...after][0] ?? '';
      if(NAME_CHAR.test(beforeChar) || NAME_CHAR.test(afterChar)) return match;
      found = true;
      return ' '.repeat(match.length);
    });
    if(found) matched.add(entry.pubkey);
  }

  return roster.filter((entry) => matched.has(entry.pubkey)).map((entry) => entry.pubkey);
}

export interface GroupReplyDecision {
  reply: boolean;
  nextLastAddressed: string[];
}

export function decideGroupReply(input: {
  selfPubkey: string;
  text: string;
  /** Every bot in the group, self included. */
  bots: RosterEntry[];
  lastAddressed: string[];
}): GroupReplyDecision {
  const otherBotPresent = input.bots.some((bot) => bot.pubkey !== input.selfPubkey);
  if(!otherBotPresent) {
    return {reply: true, nextLastAddressed: input.lastAddressed};
  }

  const matched = matchRosterNames(input.text, input.bots);
  if(matched.length) {
    return {reply: matched.includes(input.selfPubkey), nextLastAddressed: matched};
  }
  return {
    reply: input.lastAddressed.includes(input.selfPubkey),
    nextLastAddressed: input.lastAddressed
  };
}

/** One attacker-controlled field flattened to a single bounded line. */
function flatten(value: string, limit: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export interface ContextEntry {
  from: string;
  text: string;
}

/** Messages seen but not answered, as a preamble for the next prompt. */
export function formatGroupContext(entries: ContextEntry[]): string {
  const lines = entries
  .map((entry) => `${flatten(entry.from, 80)}: ${flatten(entry.text, 2000)}`)
  .filter((line) => line.length > 2);
  if(!lines.length) return '';
  return ['[Recent group messages you saw but did not reply to, for context:', ...lines, ']'].join('\n');
}
