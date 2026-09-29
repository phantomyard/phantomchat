type AudioDocumentAttribute = {
  pFlags: {voice?: boolean};
};

/**
 * Classifies a document carrying a `documentAttributeAudio` as a voice note
 * or a plain audio file — used by appDocsManager.saveDoc when stored docs are
 * re-served after a refresh.
 *
 * The sender's `voice` flag is the ONLY authoritative signal: tweb used to
 * also require an exact `audio/ogg` mime here, which reclassified phantom
 * voice notes served as MP3 (`audio/mpeg`) and real voice notes labeled
 * `audio/ogg; codecs=opus` as plain audio after a reload — dropping the
 * voice bubble (bars, waveform) for messages that rendered correctly live.
 * Telegram's own voice notes always carry the flag, so trusting it alone
 * changes nothing for genuine Telegram documents.
 */
export default function getAudioDocumentType(attribute: AudioDocumentAttribute): 'voice' | 'audio' {
  return attribute.pFlags.voice ? 'voice' : 'audio';
}
