import http from 'http';
import https from 'https';

export async function transcribe(audioBuffer: Buffer, whisperUrl: string): Promise<string> {
  const url = new URL('/v1/audio/transcriptions', whisperUrl);

  const boundary = '----VoxTypeBoundary' + Date.now();
  const parts: Buffer[] = [];

  // file field
  const fileHeader = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="audio.webm"',
    'Content-Type: audio/webm',
    '',
    '',
  ].join('\r\n');
  parts.push(Buffer.from(fileHeader, 'utf-8'));
  parts.push(audioBuffer);

  // model field
  const modelField = [
    '',
    `--${boundary}`,
    'Content-Disposition: form-data; name="model"',
    '',
    'whisper-1',
  ].join('\r\n');
  parts.push(Buffer.from(modelField, 'utf-8'));

  // language field
  const langField = [
    '',
    `--${boundary}`,
    'Content-Disposition: form-data; name="language"',
    '',
    'en',
  ].join('\r\n');
  parts.push(Buffer.from(langField, 'utf-8'));

  // response_format field
  const formatField = [
    '',
    `--${boundary}`,
    'Content-Disposition: form-data; name="response_format"',
    '',
    'json',
  ].join('\r\n');
  parts.push(Buffer.from(formatField, 'utf-8'));

  // closing boundary
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'));

  const body = Buffer.concat(parts);

  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode !== 200) {
          reject(new Error(`Whisper STT error ${res.statusCode}: ${raw}`));
          return;
        }
        try {
          const json = JSON.parse(raw);
          resolve(json.text || '');
        } catch {
          // If not JSON, return raw text
          resolve(raw.trim());
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
