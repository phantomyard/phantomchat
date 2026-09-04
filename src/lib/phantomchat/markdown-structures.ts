import type {MessageEntity} from '@layer';

type Edit = {
  start: number;
  removed: number;
  inserted: number;
};

function remapPosition(position: number, edits: Edit[]): number {
  let delta = 0;
  for(const edit of edits) {
    if(position < edit.start) break;
    if(position < edit.start + edit.removed) {
      return edit.start + delta + edit.inserted;
    }
    delta += edit.inserted - edit.removed;
  }
  return position + delta;
}

/**
 * Converts block-level Markdown that has no direct tweb parser support into
 * clean display text and native MessageEntities where possible.
 *
 * Inline Markdown and fenced code must be parsed first. Their entities are
 * remapped around the removed/replaced line prefixes; preformatted ranges are
 * deliberately left untouched.
 */
export function renderMarkdownStructures(
  text: string,
  currentEntities: MessageEntity[] = []
): [string, MessageEntity[]] {
  if(!text) return [text, currentEntities];

  const preRanges = currentEntities
  .filter((entity) => entity._ === 'messageEntityPre')
  .map((entity) => [entity.offset, entity.offset + entity.length] as const);
  const isInPre = (offset: number) => preRanges.some(([start, end]) => offset >= start && offset < end);
  const edits: Edit[] = [];
  const structuralEntities: MessageEntity[] = [];
  const output: string[] = [];
  let sourceOffset = 0;
  let outputOffset = 0;

  for(const line of text.split('\n')) {
    let rendered = line;
    const lineInPre = isInPre(sourceOffset);

    if(!lineInPre) {
      const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/);
      const task = line.match(/^(\s*)[-+*][ \t]+\[([ xX])\][ \t]+(.*)$/);
      const unordered = line.match(/^(\s*)[-+*][ \t]+(.*)$/);
      const quote = line.match(/^ {0,3}>[ \t]?(.*)$/);

      if(heading) {
        const prefixLength = line.indexOf(heading[1]);
        const suffixLength = line.length - prefixLength - heading[1].length;
        rendered = heading[1];
        edits.push({start: sourceOffset, removed: prefixLength, inserted: 0});
        if(suffixLength) {
          edits.push({
            start: sourceOffset + prefixLength + heading[1].length,
            removed: suffixLength,
            inserted: 0
          });
        }
        structuralEntities.push({
          _: 'messageEntityBold',
          offset: outputOffset,
          length: rendered.length
        });
      } else if(task) {
        const prefixLength = line.length - task[3].length;
        const marker = task[2] === ' ' ? '☐ ' : '☑ ';
        rendered = task[1] + marker + task[3];
        edits.push({
          start: sourceOffset + task[1].length,
          removed: prefixLength - task[1].length,
          inserted: marker.length
        });
      } else if(unordered) {
        const prefixLength = line.length - unordered[2].length;
        rendered = unordered[1] + '• ' + unordered[2];
        edits.push({
          start: sourceOffset + unordered[1].length,
          removed: prefixLength - unordered[1].length,
          inserted: 2
        });
      } else if(quote) {
        const prefixLength = line.length - quote[1].length;
        rendered = quote[1];
        edits.push({start: sourceOffset, removed: prefixLength, inserted: 0});
        if(rendered.length) {
          structuralEntities.push({
            _: 'messageEntityBlockquote',
            pFlags: {},
            offset: outputOffset,
            length: rendered.length
          });
        }
      }
    }

    output.push(rendered);
    sourceOffset += line.length + 1;
    outputOffset += rendered.length + 1;
  }

  const entities: MessageEntity[] = currentEntities.map((entity): MessageEntity => {
    const start = remapPosition(entity.offset, edits);
    const end = remapPosition(entity.offset + entity.length, edits);
    return {...entity, offset: start, length: Math.max(0, end - start)};
  });

  entities.push(...structuralEntities);
  entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return [output.join('\n'), entities];
}
