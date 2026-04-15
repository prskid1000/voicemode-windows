import http from 'http';

// Kokoro voice catalog + helpers. Voice selection is stored in
// AppSettings.kokoroVoice. VoxType owns the Kokoro child process via
// services.ts, so we no longer need to write ~/.voicemode/voicemode.env or
// restart any scheduled task — the voice is just used per-request.

export const FEATURED_VOICES = [
  { id: 'af_sky', label: 'Sky (F, American)' },
  { id: 'af_heart', label: 'Heart (F, American)' },
  { id: 'af_bella', label: 'Bella (F, American)' },
  { id: 'af_nova', label: 'Nova (F, American)' },
  { id: 'af_sarah', label: 'Sarah (F, American)' },
  { id: 'af_nicole', label: 'Nicole (F, American)' },
  { id: 'af_jessica', label: 'Jessica (F, American)' },
  { id: 'am_adam', label: 'Adam (M, American)' },
  { id: 'am_michael', label: 'Michael (M, American)' },
  { id: 'am_eric', label: 'Eric (M, American)' },
  { id: 'am_liam', label: 'Liam (M, American)' },
  { id: 'bf_emma', label: 'Emma (F, British)' },
  { id: 'bf_alice', label: 'Alice (F, British)' },
  { id: 'bm_george', label: 'George (M, British)' },
  { id: 'bm_daniel', label: 'Daniel (M, British)' },
] as const;

/**
 * Send a tiny TTS request to warm up the Kokoro model. Used at startup
 * (when Kokoro is enabled) so the first real request is fast.
 */
export async function preloadKokoro(port: number, voice: string): Promise<void> {
  console.log('[VoxType] Preloading Kokoro model...');
  const payload = JSON.stringify({ model: 'kokoro', input: 'ok', voice });
  return new Promise((resolve) => {
    const req = http.request(
      `http://127.0.0.1:${port}/v1/audio/speech`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode === 200) console.log('[VoxType] Kokoro preloaded');
          else console.log(`[VoxType] Kokoro preload returned ${res.statusCode}`);
          resolve();
        });
      },
    );
    req.on('error', (e) => {
      console.log(`[VoxType] Kokoro preload failed: ${e.message}`);
      resolve();
    });
    req.setTimeout(30000, () => { req.destroy(); resolve(); });
    req.write(payload);
    req.end();
  });
}
