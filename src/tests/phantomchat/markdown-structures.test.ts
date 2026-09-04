import {describe, expect, it} from 'vitest';
import parseMarkdown from '@lib/richTextProcessor/parseMarkdown';
import {renderMarkdownStructures} from '@lib/phantomchat/markdown-structures';

function render(input: string) {
  const [text, entities] = parseMarkdown(input);
  return renderMarkdownStructures(text, entities);
}

describe('renderMarkdownStructures', () => {
  it('renders headings as bold text without Markdown markers', () => {
    const [text, entities] = render('## Release **status**');

    expect(text).toBe('Release status');
    expect(entities).toEqual(expect.arrayContaining([
      expect.objectContaining({_: 'messageEntityBold', offset: 0, length: 14})
    ]));
  });

  it('preserves inline entity offsets inside headings', () => {
    const [text, entities] = render('### Read [the docs](https://example.com) ###');

    expect(text).toBe('Read the docs');
    expect(entities).toEqual(expect.arrayContaining([
      expect.objectContaining({_: 'messageEntityTextUrl', offset: 5, length: 8})
    ]));
  });

  it('renders nested unordered and task lists with readable markers', () => {
    const [text] = render([
      '- Parent',
      '  * Child',
      '- [ ] Pending',
      '- [x] Complete'
    ].join('\n'));

    expect(text).toBe([
      '• Parent',
      '  • Child',
      '☐ Pending',
      '☑ Complete'
    ].join('\n'));
  });

  it('renders quotes through the native blockquote entity', () => {
    const [text, entities] = render('> quoted **bold** text');

    expect(text).toBe('quoted bold text');
    expect(entities).toEqual(expect.arrayContaining([
      expect.objectContaining({_: 'messageEntityBlockquote', offset: 0, length: 16}),
      expect.objectContaining({_: 'messageEntityBold', offset: 7, length: 4})
    ]));
  });

  it('leaves Markdown-looking content inside fenced code unchanged', () => {
    const input = '```markdown\n# heading\n- [x] task\n> quote\n```';
    const [text, entities] = render(input);

    expect(text).toBe('# heading\n- [x] task\n> quote');
    expect(entities.map((entity) => entity._)).toEqual(['messageEntityPre']);
  });

  it('keeps raw HTML as inert text and malformed markers untouched', () => {
    const input = '<img src=x onerror=alert(1)>\n#missing-space\n-';
    const [text, entities] = render(input);

    expect(text).toBe(input);
    expect(entities).toEqual([]);
  });
});
