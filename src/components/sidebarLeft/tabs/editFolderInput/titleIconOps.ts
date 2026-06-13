// Pure helpers for prepending/replacing the leading emoji of a folder title.

// Matches a leading emoji "cluster":
//  - a pictographic base (optionally with a variation selector),
//    followed by zero or more ZWJ-joined pictographics (family, profession, etc.)
//  - OR a flag sequence (two regional indicators)
// Keycap sequences (e.g. 1️⃣) are intentionally out of scope — their base
// character is an ASCII digit, not an Extended_Pictographic.
const EMOJI_RE = /^(?:\p{Extended_Pictographic}\uFE0F?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*|\p{Regional_Indicator}{2})/u;

export function extractLeadingEmoji(title: string): string | null {
  if(!title) return null;
  const m = title.match(EMOJI_RE);
  return m ? m[0] : null;
}

export function setLeadingEmoji(title: string, emoji: string, maxLen: number): string {
  const current = extractLeadingEmoji(title);
  let rest: string;
  if(current) {
    rest = title.slice(current.length).replace(/^\s+/, '');
  } else {
    rest = title;
  }
  const separator = rest.length ? ' ' : '';
  const combined = emoji + separator + rest;
  if(combined.length <= maxLen) return combined;
  // Truncate the text tail; the emoji wins.
  const budget = maxLen - emoji.length - separator.length;
  if(budget <= 0) return emoji;
  return emoji + separator + rest.slice(0, budget);
}
