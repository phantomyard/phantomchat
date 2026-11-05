import {describe, it, expect} from 'vitest';
import {
  MARKDOWN_TABLE_LANGUAGE,
  buildMarkdownTableElement,
  parseMarkdownTable,
  renderMarkdownTables
} from '@lib/phantomchat/markdown-tables';

const FENCE = '```' + MARKDOWN_TABLE_LANGUAGE;

describe('renderMarkdownTables', () => {
  it('wraps a GFM table in a phantomchat-table fence, source kept', () => {
    const input = [
      '| Item | Check |',
      '|------|-------|',
      '| Markdown | yes |',
      '| Tables | yes |'
    ].join('\n');

    expect(renderMarkdownTables(input)).toBe(FENCE + '\n' + input + '\n```');
  });

  it('leaves text without tables untouched', () => {
    const input = 'Hello **world**, here is `code`.';
    expect(renderMarkdownTables(input)).toBe(input);
  });

  it('does NOT treat pipes inside a code block as a table', () => {
    const input = [
      '```bash',
      'cat /proc/loadavg | awk \'{print $1}\'',
      '| A | B |',
      '|---|---|',
      '```'
    ].join('\n');
    expect(renderMarkdownTables(input)).toBe(input);
  });

  it('handles a table preceded and followed by prose', () => {
    const input = [
      'Here is the status:',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Done.'
    ].join('\n');
    expect(renderMarkdownTables(input)).toBe(
      'Here is the status:\n' + FENCE + '\n| A | B |\n|---|---|\n| 1 | 2 |\n```\n\nDone.'
    );
  });

  it('leaves a table whose cells contain ``` as plain text', () => {
    const input = '| A |\n|---|\n| ```x``` |';
    expect(renderMarkdownTables(input)).toBe(input);
  });
});

describe('parseMarkdownTable', () => {
  it('parses header, alignment, rows, escaped pipes and ragged rows', () => {
    const table = parseMarkdownTable([
      '| Name | Qty | Note |',
      '|:-----|----:|:----:|',
      '| a \\| b | 2 |',
      '| c | 3 | x | extra |'
    ].join('\n'));

    expect(table).toEqual({
      header: ['Name', 'Qty', 'Note'],
      align: ['left', 'right', 'center'],
      rows: [['a | b', '2', ''], ['c', '3', 'x']]
    });
  });

  it('returns null for non-table text', () => {
    expect(parseMarkdownTable('just | some pipes\nno separator')).toBeNull();
  });
});

describe('buildMarkdownTableElement', () => {
  it('builds a real table, cells rendered via the callback (no innerHTML)', () => {
    const el = buildMarkdownTableElement(
      '| A | B |\n|---|--:|\n| <img src=x onerror=alert(1)> | 2 |',
      (cell) => document.createTextNode(cell)
    );

    expect(el.classList.contains('markdown-table')).toBe(true);
    const ths = [...el.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(ths).toEqual(['A', 'B']);
    const tds = el.querySelectorAll('tbody td');
    expect(tds).toHaveLength(2);
    // Markup in a cell is text, never parsed as HTML.
    expect(el.querySelector('img')).toBeNull();
    expect(tds[0].textContent).toBe('<img src=x onerror=alert(1)>');
    expect((tds[1] as HTMLElement).style.textAlign).toBe('right');
  });

  it('returns null when the source is not a table', () => {
    expect(buildMarkdownTableElement('not a table', (c) => document.createTextNode(c))).toBeNull();
  });
});
