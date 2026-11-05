/**
 * GFM Markdown tables for chat bubbles.
 *
 * tweb has no table MessageEntity, so a table travels through the entity
 * pipeline as a fenced block tagged with the reserved language
 * `MARKDOWN_TABLE_LANGUAGE`. `wrapRichText` recognises that language and draws
 * a real `<table>` (see `buildMarkdownTableElement`). Every cell is built with
 * DOM APIs and its inline Markdown goes through the normal entity renderer, so
 * there is no raw-HTML path and nothing to sanitise. Anywhere formatting is
 * off (dialog previews, notifications, copy) the block degrades to the
 * original Markdown source, which still reads as a table.
 *
 * Fence-aware: pipes inside a ``` code block (e.g. `cat x | awk …`) are left
 * alone so a real code block is never mistaken for a table.
 */

export const MARKDOWN_TABLE_LANGUAGE = 'phantomchat-table';

export type MarkdownTableAlign = 'left' | 'center' | 'right' | undefined;

export type MarkdownTable = {
  header: string[],
  align: MarkdownTableAlign[],
  rows: string[][]
};

// A GFM separator row: |---|:--:| etc. (pipes, dashes, optional colons, spaces).
const SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Split a table row on unescaped pipes; `\|` becomes a literal pipe. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if(s.startsWith('|')) s = s.slice(1);
  if(s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  for(let i = 0; i < s.length; ++i) {
    const char = s[i];
    if(char === '\\' && s[i + 1] === '|') {
      current += '|';
      ++i;
    } else if(char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseAlign(cell: string): MarkdownTableAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if(left && right) return 'center';
  if(right) return 'right';
  if(left) return 'left';
  return undefined;
}

/**
 * Parse a GFM table (header, separator, body rows). Returns null if `source`
 * is not a table, so callers can fall back to plain rendering.
 */
export function parseMarkdownTable(source: string): MarkdownTable | null {
  const lines = source.split('\n').filter((line) => line.trim());
  if(lines.length < 2 || !lines[0].includes('|') || !lines[1].includes('|') || !SEPARATOR_RE.test(lines[1])) {
    return null;
  }

  const header = splitRow(lines[0]);
  const align = splitRow(lines[1]).map(parseAlign);
  const cols = header.length;
  const rows = lines.slice(2).map((line) => {
    const cells = splitRow(line);
    // GFM: the header fixes the column count; pad short rows, drop extras.
    return Array.from({length: cols}, (_, c) => cells[c] ?? '');
  });

  return {header, align: Array.from({length: cols}, (_, c) => align[c]), rows};
}

/**
 * Wrap every GFM table in `text` in a ```phantomchat-table fence so the bubble
 * renderer draws it as a table. Non-table text is returned untouched.
 */
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

    // A table = header row (has a pipe) + a separator row.
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

    let j = i + 2;
    while(j < lines.length && lines[j].includes('|') && lines[j].trim()) {
      j++;
    }

    const block = lines.slice(i, j).map((l) => l.trim());
    // A ``` inside a cell would close our fence early; leave such a table as text.
    if(block.some((l) => l.includes('```'))) {
      out.push(...lines.slice(i, j));
    } else {
      out.push('```' + MARKDOWN_TABLE_LANGUAGE + '\n' + block.join('\n') + '\n```');
    }
    i = j;
  }

  return out.join('\n');
}

/**
 * Build a `<table>` for the source of a ```phantomchat-table block. Cell
 * contents are produced by `renderCell` (inline Markdown → DOM); returns null
 * when the source is not a table so the caller can render a code block.
 */
export function buildMarkdownTableElement(
  source: string,
  renderCell: (cellMarkdown: string) => Node
): HTMLElement | null {
  const table = parseMarkdownTable(source);
  if(!table) return null;

  const wrapper = document.createElement('div');
  wrapper.classList.add('markdown-table');
  const tableElement = document.createElement('table');
  wrapper.append(tableElement);

  const fillRow = (cells: string[], tag: 'th' | 'td') => {
    const tr = document.createElement('tr');
    cells.forEach((cell, c) => {
      const element = document.createElement(tag);
      const align = table.align[c];
      if(align) element.style.textAlign = align;
      if(cell) element.append(renderCell(cell));
      tr.append(element);
    });
    return tr;
  };

  const thead = document.createElement('thead');
  thead.append(fillRow(table.header, 'th'));
  tableElement.append(thead);

  if(table.rows.length) {
    const tbody = document.createElement('tbody');
    table.rows.forEach((row) => tbody.append(fillRow(row, 'td')));
    tableElement.append(tbody);
  }

  return wrapper;
}
