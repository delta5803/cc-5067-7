// Node-side 16-bit stereo WAV encoder. Mirrors web/js/audio/wav.js (which uses
// Blob) so generated samples are byte-compatible with the panel's export.

export function encodeWav16Node(L, R, sampleRate) {
  const n = Math.min(L.length, R.length);
  const dataBytes = n * 2 * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < n; i++) {
    buffer.writeInt16LE(clamp16(L[i]), off); off += 2;
    buffer.writeInt16LE(clamp16(R[i]), off); off += 2;
  }
  return buffer;
}

function clamp16(v) {
  v = Math.max(-1, Math.min(1, v));
  return v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
}
