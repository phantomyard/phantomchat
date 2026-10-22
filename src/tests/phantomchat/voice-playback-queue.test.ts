import {afterEach, beforeEach, describe, it, expect, vi} from 'vitest';
vi.mock('@components/preloader', () => ({default: vi.fn()}));
vi.mock('@components/appMediaPlaybackController', () => ({default: {setSearchContext: vi.fn(), setTargets: vi.fn(), getListLoaderFactory: vi.fn()}}));
vi.mock('@helpers/mediaSizes', () => ({default: vi.fn()}));
vi.mock('@lib/rootScope', () => ({default: {addEventListener: vi.fn()}}));
vi.mock('@helpers/dom/clickEvent', () => ({default: vi.fn()}));
vi.mock('@components/lazyLoadQueue', () => ({default: vi.fn()}));
vi.mock('@lib/langPack', () => ({default: vi.fn()}));
vi.mock('@components/middleEllipsis', () => ({default: vi.fn()}));
vi.mock('@helpers/date', () => ({default: vi.fn()}));
vi.mock('@helpers/animation', () => ({default: vi.fn()}));
vi.mock('@components/mediaProgressLine', () => ({default: vi.fn()}));
vi.mock('@lib/richTextProcessor/wrapEmojiText', () => ({default: vi.fn()}));
vi.mock('@components/wrappers/senderToPeer', () => ({default: vi.fn()}));
vi.mock('@components/wrappers/sentTime', () => ({default: vi.fn()}));
vi.mock('@lib/appDownloadManager', () => ({default: vi.fn()}));
vi.mock('@components/wrappers/photo', () => ({default: vi.fn()}));
vi.mock('@helpers/tgico', () => ({default: vi.fn()}));
vi.mock('@components/icon', () => ({default: vi.fn()}));
vi.mock('@components/toast', () => ({default: vi.fn()}));
vi.mock('@helpers/dom/anchorCallback', () => ({default: vi.fn()}));
vi.mock('@components/popups/premium', () => ({default: vi.fn()}));
vi.mock('@lib/phantomchat/phantomchat-voice-decode', () => ({default: vi.fn()}));

// Keep rendering, downloads, and app boot outside this DOM interaction test.
// The production AudioElement and findMediaTargets run unchanged.
import '@helpers/peerIdPolyfill';
import AudioElement from '@components/audio';
import appMediaPlaybackController from '@components/appMediaPlaybackController';

const peerId = (1000000000000001).toPeerId();

function voiceFixture(mids: number[], customLoader = false) {
  const container = document.createElement('div');
  container.className = 'bubbles-inner';
  return mids.map((mid) => {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const voice = new AudioElement();
    voice.className = 'audio is-voice';
    voice.dataset.mid = String(mid);
    voice.dataset.peerId = String(peerId);
    voice.message = {mid, peerId} as AudioElement['message'];
    voice.searchContext = {peerId, inputFilter: {_: 'inputMessagesFilterRoundVoice'}};
    if(customLoader) voice.listLoaderFactory = vi.fn();
    bubble.append(voice);
    container.append(bubble);
    return voice;
  });
}

describe('voice playback queue', () => {
  beforeEach(() => {
    vi.mocked(appMediaPlaybackController.setSearchContext).mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('seeds the voices below a new gesture even when the chat context is unchanged', () => {
    // Non-monotonic mids model legacy same-second voices. DOM order wins.
    const voices = voiceFixture([9, 4, 7]);
    voices[0].setTargetsIfNeeded();
    expect(appMediaPlaybackController.setTargets).toHaveBeenLastCalledWith(
      {peerId, mid: 9}, [], [{peerId, mid: 4}, {peerId, mid: 7}], undefined
    );
  });

  it('picks up newly rendered voices after the previous queue has drained', () => {
    const voices = voiceFixture([1, 2, 3]);
    voices[0].setTargetsIfNeeded();
    // Reuse the same element and context after new history_append bubbles.
    const extra = voiceFixture([4, 5]);
    const container = voices[0].closest('.bubbles-inner');
    extra.forEach((voice) => container.append(voice.parentElement));
    voices[2].setTargetsIfNeeded();
    expect(appMediaPlaybackController.setTargets).toHaveBeenLastCalledWith(
      {peerId, mid: 3}, [{peerId, mid: 1}, {peerId, mid: 2}],
      [{peerId, mid: 4}, {peerId, mid: 5}], undefined
    );
  });

  it('seeds an empty next queue at the bottom so it stops without wrapping', () => {
    const voices = voiceFixture([1, 2]);
    voices[1].setTargetsIfNeeded();
    expect(appMediaPlaybackController.setTargets).toHaveBeenCalledWith(
      {peerId, mid: 2}, [{peerId, mid: 1}], [], undefined
    );
  });

  it('preserves a custom playlist when its loader and context are unchanged', () => {
    const [voice] = voiceFixture([1], true);
    vi.mocked(appMediaPlaybackController.getListLoaderFactory).mockReturnValue(voice.listLoaderFactory);
    voice.setTargetsIfNeeded();
    expect(appMediaPlaybackController.setTargets).not.toHaveBeenCalled();
  });

  it('preserves music playback when the context has not changed', () => {
    const [voice] = voiceFixture([1]);
    voice.classList.remove('is-voice');
    voice.setTargetsIfNeeded();
    expect(appMediaPlaybackController.setTargets).not.toHaveBeenCalled();
  });
});
