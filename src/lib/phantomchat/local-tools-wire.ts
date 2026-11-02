/**
 * Marker for remote tool traffic (#276). Lives on its own, and imports nothing, so
 * the receive path can recognise and drop these rumors on every client without
 * pulling in the rest of the feature.
 */
export const LOCAL_TOOLS_TAG = 'phantomchat-local-tools';

export function isLocalToolsRumor(tags: string[][] | undefined): boolean {
  return Array.isArray(tags) && tags.some((tag) => Array.isArray(tag) && tag[0] === LOCAL_TOOLS_TAG);
}

/**
 * Software that predates this protocol must not act on it, in both directions.
 * The `control` tag makes an older PhantomChat client drop it as a control message
 * of no type it knows. A string `type` other than 'text' makes phantombot drop it:
 * JSON without one is read as plain text, which would start a turn.
 */
export function toolMessageTags(recipient: string): string[][] {
  return [['p', recipient], [LOCAL_TOOLS_TAG, '1'], ['control', 'true']];
}

export function toolMessageContent(message: unknown): string {
  return JSON.stringify({...(message as object), type: LOCAL_TOOLS_TAG});
}
