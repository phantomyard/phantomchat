/**
 * Yields a real macro-task back to the event loop, letting the browser paint and
 * process input between bursts of synchronous work.
 *
 * Uses MessageChannel rather than setTimeout(0): a nested setTimeout is clamped
 * to ~4ms by the HTML spec and throttled to 1000ms+ in background/inactive tabs,
 * so a setTimeout-paced backfill crawls when the tab is not focused. A
 * MessageChannel ping is subject to neither clamp nor throttle. Falls back to
 * setTimeout where MessageChannel is unavailable (e.g. some test environments).
 */
export default function yieldToMainThread(): Promise<void> {
  return new Promise<void>((resolve) => {
    if(typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }

    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}
