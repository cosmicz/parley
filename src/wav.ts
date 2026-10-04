/** Wrap 16 kHz mono signed 16-bit little-endian PCM in a standard WAV file. */
export function encodeWav16kMono(pcm: Uint8Array): Uint8Array {
  if (pcm.byteLength % 2 !== 0) throw new RangeError('PCM16 must contain whole samples');
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) wav[offset + i] = value.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM format chunk length
  view.setUint16(20, 1, true); // linear PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per sample frame
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
}
