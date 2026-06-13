import type {Page, Locator} from 'playwright';

export type SelectorCandidate =
  | {kind: 'testid'; value: string}
  | {kind: 'role'; role: string; name: string}
  | {kind: 'text'; value: string}
  | {kind: 'aria'; value: string}
  | {kind: 'class'; value: string};

/**
 * Build candidate selectors from a free-text hint, in priority order:
 * 1. data-testid exact
 * 2. ARIA role + accessible name
 * 3. visible text contains
 * 4. aria-label exact
 * 5. CSS class match
 *
 * Returns [] for empty hint.
 */
export function buildSelectorCandidates(hint: string): SelectorCandidate[] {
  if(!hint || hint.trim().length === 0) return [];
  const trimmed = hint.trim();
  const roleMatch = /\b(button|link|textbox|input|menuitem|tab|checkbox)\b/i.exec(trimmed);
  const candidates: SelectorCandidate[] = [
    {kind: 'testid', value: trimmed}
  ];
  if(roleMatch) {
    const role = roleMatch[1].toLowerCase().replace('input', 'textbox');
    const name = trimmed.replace(roleMatch[0], '').trim();
    if(name) candidates.push({kind: 'role', role, name});
  } else {
    candidates.push({kind: 'role', role: 'generic', name: trimmed});
  }
  candidates.push({kind: 'text', value: trimmed});
  candidates.push({kind: 'aria', value: trimmed});
  candidates.push({kind: 'class', value: trimmed});
  return candidates;
}

/**
 * Given a page and a hint, return the first Locator that matches the priority
 * chain. Returns null if nothing resolves.
 *
 * Hints starting with `.` or `[` are treated as raw Playwright CSS selectors
 * and tried first (covers compound selectors like `.bubble.is-out` and
 * attribute selectors like `[data-mid]` that the heuristic chain mishandles).
 */
export async function resolveSelector(page: Page, hint: string): Promise<Locator | null> {
  const trimmed = hint?.trim() ?? '';
  if(trimmed.startsWith('.') || trimmed.startsWith('[')) {
    const loc = page.locator(trimmed).first();
    const count = await loc.count().catch(() => 0);
    if(count > 0) return loc;
  }
  const candidates = buildSelectorCandidates(hint);
  for(const c of candidates) {
    let loc: Locator;
    switch(c.kind) {
      case 'testid':
        loc = page.locator(`[data-testid="${cssEscape(c.value)}"]`).first();
        break;
      case 'role':
        loc = page.getByRole(c.role as any, {name: c.name}).first();
        break;
      case 'text':
        loc = page.getByText(c.value, {exact: false}).first();
        break;
      case 'aria':
        loc = page.locator(`[aria-label="${cssEscape(c.value)}"]`).first();
        break;
      case 'class': {
        // Strip any leading dot the caller may have included so we don't end up
        // with `..foo` (which Playwright treats as an invalid pseudo-element).
        const stripped = c.value.replace(/^\.+/, '');
        loc = page.locator(`.${cssEscape(stripped).replace(/ /g, '.')}`).first();
        break;
      }
    }
    const count = await loc.count().catch(() => 0);
    if(count > 0) return loc;
  }
  return null;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
