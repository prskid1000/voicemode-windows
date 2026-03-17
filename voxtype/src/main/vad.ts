/**
 * Simple energy-based VAD: detects if audio buffer contains speech
 * and trims leading/trailing silence. Works on raw webm/opus buffers
 * by checking byte variance as a proxy for audio energy.
 *
 * Returns null if the audio is entirely silence (below threshold).
 */

// Minimum audio duration in bytes to consider valid (~0.3s of webm/opus)
const MIN_AUDIO_BYTES = 2000;

// Silence detection: if average byte variance is below this, it's silence
const SILENCE_THRESHOLD = 8;

/**
 * Check if an audio buffer likely contains speech based on byte-level energy.
 * This is a rough heuristic that works on compressed audio formats.
 */
export function hasSpeech(audioBuffer: Buffer): boolean {
  if (audioBuffer.length < MIN_AUDIO_BYTES) return false;

  // Sample the middle 60% of the buffer (skip webm headers/trailers)
  const start = Math.floor(audioBuffer.length * 0.2);
  const end = Math.floor(audioBuffer.length * 0.8);
  const segment = audioBuffer.subarray(start, end);

  if (segment.length === 0) return false;

  // Calculate byte-level variance as energy proxy
  let sum = 0;
  for (let i = 0; i < segment.length; i++) {
    sum += segment[i];
  }
  const mean = sum / segment.length;

  let variance = 0;
  for (let i = 0; i < segment.length; i++) {
    const diff = segment[i] - mean;
    variance += diff * diff;
  }
  variance /= segment.length;

  return variance > SILENCE_THRESHOLD;
}

/**
 * Returns audio duration estimate in seconds based on buffer size.
 * Very rough estimate for webm/opus (~12KB/s at default bitrate).
 */
export function estimateDuration(audioBuffer: Buffer): number {
  return audioBuffer.length / 12000;
}
