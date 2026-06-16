import {describe, it, expect} from 'vitest';
import {renderMarkdownTables} from '@lib/phantomchat/markdown-tables';

describe('renderMarkdownTables', () => {
  it('reflows a GFM table into an aligned, fenced monospace block', () => {
    const input = [
      '| Item | Check |',
      '|------|-------|',
      '| Markdown | yes |',
      '| Tables | yes |'
    ].join('\n');

    const out = renderMarkdownTables(input);
    // Wrapped in a fence so the pre renderer shows it as a monospace grid.
    expect(out.startsWith('```')).toBe(true);
    expect(out.trimEnd().endsWith('```')).toBe(true);
    // Columns padded to equal width → header cell 'Item' padded to 'Markdown' width.
    expect(out).toContain('Item    ');
    expect(out).toContain('Markdown');
    // The literal GFM separator row (|---|) is gone, replaced by dashes.
    expect(out).not.toContain('|------|');
  });

  it('leaves text without tables untouched', () => {
    const input = 'Hello **world**, here is `code`.';
    expect(renderMarkdownTables(input)).toBe(input);
  });

  it('does NOT treat pipes inside a code block as a table', () => {
    const input = [
      '```bash',
      'cat /proc/loadavg | awk \'{print $1}\'',
      'echo a | grep b',
      '```'
    ].join('\n');
    // No separator row inside, and it's fenced → returned verbatim.
    expect(renderMarkdownTables(input)).toBe(input);
  });

  it('handles a table preceded and followed by prose', () => {
    const input = [
      'Here is the status:',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      'Done.'
    ].join('\n');
    const out = renderMarkdownTables(input);
    expect(out.startsWith('Here is the status:\n```')).toBe(true);
    expect(out.endsWith('```\nDone.')).toBe(true);
  });
});
