/**
 * Converts raw PCM audio data (base64) to a WAV data URL.
 * Gemini TTS output is 24kHz, 16-bit, mono PCM.
 */
export function pcmBase64ToWavUrl(base64: string, sampleRate: number = 24000): string {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }

  // Create WAV header
  const wavHeader = createWavHeader(buffer.byteLength, sampleRate);
  
  // Combine header and PCM data
  const wavBuffer = new Uint8Array(wavHeader.byteLength + buffer.byteLength);
  wavBuffer.set(new Uint8Array(wavHeader), 0);
  wavBuffer.set(new Uint8Array(buffer), wavHeader.byteLength);

  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

/**
 * Merges multiple raw PCM audio base64 strings into a single WAV data URL.
 */
export function mergePcmBase64ToWavUrl(base64Strings: string[], sampleRate: number = 24000): string {
  // Decode all base64 strings into Uint8Arrays
  const buffers = base64Strings.map(base64 => {
    const binary = atob(base64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      buffer[i] = binary.charCodeAt(i);
    }
    return buffer;
  });

  // Calculate total length
  const totalDataLength = buffers.reduce((acc, buf) => acc + buf.length, 0);

  // Create WAV header
  const wavHeader = createWavHeader(totalDataLength, sampleRate);

  // Combine header and all PCM data
  const wavBuffer = new Uint8Array(wavHeader.byteLength + totalDataLength);
  wavBuffer.set(new Uint8Array(wavHeader), 0);
  
  let offset = wavHeader.byteLength;
  for (const buf of buffers) {
    wavBuffer.set(buf, offset);
    offset += buf.length;
  }

  const blob = new Blob([wavBuffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

function createWavHeader(dataLength: number, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // "RIFF"
  writeString(view, 0, 'RIFF');
  // file length
  view.setUint32(4, 36 + dataLength, true);
  // "WAVE"
  writeString(view, 8, 'WAVE');
  // "fmt " chunk
  writeString(view, 12, 'fmt ');
  // chunk length
  view.setUint32(16, 16, true);
  // audio format (1 = PCM)
  view.setUint16(20, 1, true);
  // number of channels
  view.setUint16(22, numChannels, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate
  view.setUint32(28, byteRate, true);
  // block align
  view.setUint16(32, blockAlign, true);
  // bits per sample
  view.setUint16(34, bitsPerSample, true);
  // "data" chunk
  writeString(view, 36, 'data');
  // data length
  view.setUint32(40, dataLength, true);

  return header;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
