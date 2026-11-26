// 16-bit PCM stereo WAV encoder for real export / download.

export function encodeWav16(L, R, sampleRate) {
  const n = Math.min(L.length, R.length);
  const dataBytes = n * 2 * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buffer);

  writeAscii(dv, 0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  writeAscii(dv, 8, 'WAVE');
  writeAscii(dv, 12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);        // PCM
  dv.setUint16(22, 2, true);        // stereo
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 4, true);
  dv.setUint16(32, 4, true);
  dv.setUint16(34, 16, true);
  writeAscii(dv, 36, 'data');
  dv.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < n; i++) {
    dv.setInt16(off, clamp16(L[i]), true); off += 2;
    dv.setInt16(off, clamp16(R[i]), true); off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function clamp16(v) {
  v = Math.max(-1, Math.min(1, v));
  return v < 0 ? v * 0x8000 : v * 0x7fff;
}

function writeAscii(dv, offset, str) {
  for (let i = 0; i < str.length; i++) dv.setUint8(offset + i, str.charCodeAt(i));
}
