/** 最小有效 PCM WAV，仅用于离线测试，不能作为音色参考或音质验证。 */
export const wav = new Uint8Array(46);
const encoder = new TextEncoder();
wav.set(encoder.encode("RIFF"), 0);
wav.set(encoder.encode("WAVEfmt "), 8);
wav.set(encoder.encode("data"), 36);
const view = new DataView(wav.buffer);
view.setUint32(4, 38, true);
view.setUint32(16, 16, true);
view.setUint16(20, 1, true);
view.setUint16(22, 1, true);
view.setUint32(24, 24000, true);
view.setUint32(28, 48000, true);
view.setUint16(32, 2, true);
view.setUint16(34, 16, true);
view.setUint32(40, 2, true);
