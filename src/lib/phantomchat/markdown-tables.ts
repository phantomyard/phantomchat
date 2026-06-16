/**
 * Render GFM Markdown tables as column-aligned monospace blocks.
 *
 * tweb has no table MessageEntity, and a real bordered <table> doesn't fit its
 * entity-based bubble renderer (it would also regress the syntax-highlighted
 * code-block widget and require HTML sanitization). The pragmatic, safe
 * rendering: reflow a GFM table into aligned columns and wrap it in a fenced
 * code block, so the existing `pre` renderer shows it as a legible monospace
 * grid. Non-table text is returned untouched.
 *
 * Fence-aware: pipes inside a ``` code block (e.g. `cat x | awk …`) are left
 * alone so a real code block is never mistaken for a table.
 */

// A GFM separator row: |---|:--:| etc. (pipes, dashes, optional colons, spaces).
const SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if(s.startsWith('|')) s = s.slice(1);
  if(s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

export function renderMarkdownTables(text: string): string {
  if(!text || !text.includes('|')) return text;

  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let i = 0;

  while(i < lines.length) {
    const line = lines[i];

    // Track fenced code blocks so their contents (which may contain `|`) are
    // never reinterpreted as a table.
    if(/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }

    // A table = header row (has a pipe) + a separator row + >=1 body rows.
    const isTableStart =
      !inFence &&
      line.includes('|') &&
      i + 1 < lines.length &&
      SEPARATOR_RE.test(lines[i + 1]) &&
      lines[i + 1].includes('|');

    if(!isTableStart) {
      out.push(line);
      i++;
      continue;
    }

    const header = splitRow(line);
    const rows: string[][] = [];
    let j = i + 2;
    while(j < lines.length && lines[j].includes('|') && lines[j].trim()) {
      rows.push(splitRow(lines[j]));
      j++;
    }

    const all = [header, ...rows];
    const cols = Math.max(...all.map((r) => r.length));
    const widths: number[] = [];
    for(let c = 0; c < cols; c++) {
      widths[c] = Math.max(...all.map((r) => (r[c] ?? '').length));
    }
    const fmtRow = (r: string[]) =>
      Array.from({length: cols}, (_, c) => (r[c] ?? '').padEnd(widths[c])).join('  ');
    const separator = widths.map((w) => '-'.repeat(Math.max(1, w))).join('  ');
    const block = [fmtRow(header), separator, ...rows.map(fmtRow)].join('\n');

    // Wrap in a (language-less) fence → renders via the existing pre renderer.
    out.push('```\n' + block + '\n```');
    i = j;
  }

  return out.join('\n');
}
