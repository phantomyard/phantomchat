import 'fake-indexeddb/auto';
import {describe, it, expect, vi} from 'vitest';

// wrapRichText's import graph pulls in UI modules that need browser APIs jsdom
// lacks; stub just those (same pattern as onboarding-npub.test.ts).
vi.hoisted(() => {
  for(const name of ['IntersectionObserver', 'ResizeObserver'] as const) {
    if(typeof (globalThis as any)[name] === 'undefined') {
      (globalThis as any)[name] = class {
        observe() {}
        unobserve() {}
        disconnect() {}
        takeRecords(): any[] { return []; }
      };
    }
  }
});
vi.mock('@environment/webpSupport', () => ({default: false}));
vi.mock('@components/animationIntersector', () => ({default: {}}));
vi.mock('@components/wrappers/sticker', () => ({default: vi.fn()}));
vi.mock('@lib/apiManagerProxy', () => ({default: {}}));
import parseMarkdown from '@lib/richTextProcessor/parseMarkdown';
import wrapMessageEntities from '@lib/richTextProcessor/wrapMessageEntities';
import wrapRichText from '@lib/richTextProcessor/wrapRichText';
import {renderMarkdownStructures} from '@lib/phantomchat/markdown-structures';
import {renderMarkdownTables} from '@lib/phantomchat/markdown-tables';

// Same pipeline as phantomchat-peer-mapper → bubble: Markdown → entities →
// wrapRichText DOM.
function renderBubble(text: string, options: Parameters<typeof wrapRichText>[1] = {}) {
  const [inlineText, inlineEntities] = parseMarkdown(renderMarkdownTables(text));
  const [mdText, mdEntities] = renderMarkdownStructures(inlineText, inlineEntities);
  const {totalEntities} = wrapMessageEntities(mdText, mdEntities.slice());
  const container = document.createElement('div');
  container.append(wrapRichText(mdText, {...options, entities: totalEntities}));
  return {container, mdText};
}

describe('GFM tables in bubbles', () => {
  const message = [
    'Status:',
    '',
    '| Service | State | Docs |',
    '|---------|:-----:|------|',
    '| **api** | `up` | [link](https://example.com) |',
    '| worker | down | — |',
    '',
    'All **good**.'
  ].join('\n');

  it('renders a real <table> with formatted cells, not a code block', () => {
    const {container} = renderBubble(message);

    const table = container.querySelector('.markdown-table table');
    expect(table).not.toBeNull();
    expect(container.querySelector('pre')).toBeNull();

    const ths = [...table.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(ths).toEqual(['Service', 'State', 'Docs']);

    const firstRow = table.querySelectorAll('tbody tr')[0].querySelectorAll('td');
    expect(firstRow[0].querySelector('strong')?.textContent).toBe('api');
    expect(firstRow[1].querySelector('code')?.textContent).toBe('up');
    expect((firstRow[1] as HTMLElement).style.textAlign).toBe('center');
    expect(firstRow[2].querySelector('a')?.textContent).toBe('link');
    // No raw Markdown markers survive in the cells.
    expect(table.textContent).not.toContain('**');
    expect(table.textContent).not.toContain('|');

    // Prose around the table still renders, outside it.
    expect(container.textContent.startsWith('Status:')).toBe(true);
    const strongs = [...container.querySelectorAll('strong')].map((s) => s.textContent);
    expect(strongs).toContain('good');
    expect(table.textContent).not.toContain('All');
  });

  it('consumes the table source: prose directly after it is not preceded by raw rows', () => {
    // The table branch in wrapRichText must skip the entities (linebreaks,
    // bold, code) inside the table's range; otherwise they are processed a
    // second time and the raw rows are re-emitted after the <table>.
    const {container} = renderBubble([
      '| Service | State |',
      '|---|---|',
      '| **api** | `up` |',
      'Next line.'
    ].join('\n'));

    const table = container.querySelector('.markdown-table table');
    expect(table).not.toBeNull();
    expect(container.textContent).not.toContain('|---|');
    expect(container.textContent).not.toContain('|');
    expect(container.textContent.match(/api/g)).toHaveLength(1);
    expect(container.textContent.endsWith('Next line.')).toBe(true);
    const afterTable = container.textContent.slice(container.textContent.lastIndexOf('up') + 2);
    expect(afterTable.trim()).toBe('Next line.');
  });

  it('degrades to the Markdown source where formatting is off (previews)', () => {
    const {container} = renderBubble(message, {noTextFormat: true});
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('| Service | State | Docs |');
  });

  it('still renders an ordinary code block as a code block', () => {
    const {container} = renderBubble('```bash\necho a | grep b\n```');
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelector('pre.code')).not.toBeNull();
  });
});
