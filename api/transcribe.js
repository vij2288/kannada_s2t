import formidable from 'formidable';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

export const config = {
  api: { bodyParser: false },
};

// ─── Sarvam STT ────────────────────────────────────────────────────────────────
async function callSarvam(audioFile) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return { error: 'SARVAM_API_KEY not set' };

  const form = new FormData();
  form.append('file', fs.createReadStream(audioFile.filepath), {
    filename: 'recording.webm',
    contentType: 'audio/webm',
  });
  form.append('language_code', 'kn-IN');
  form.append('model', 'saarika:v2.5');
  form.append('with_timestamps', 'false');
  form.append('with_disfluencies', 'false');

  try {
    const res  = await fetch('https://api.sarvam.ai/speech-to-text', {
      method: 'POST',
      headers: { 'api-subscription-key': apiKey, ...form.getHeaders() },
      body: form,
    });
    const raw  = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { return { error: `Non-JSON: ${raw.slice(0, 200)}` }; }

    if (!res.ok) {
      const msg = data.message || data.error || data.detail;
      const errStr = msg ? (typeof msg === 'string' ? msg : JSON.stringify(msg)) : `HTTP ${res.status}: ${raw.slice(0, 300)}`;
      return { error: errStr };
    }
    return { transcript: data.transcript ?? data.text ?? null, raw: data };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Google Cloud STT ──────────────────────────────────────────────────────────
async function callGoogle(audioBuffer) {
  const apiKey = process.env.GOOGLE_STT_API_KEY;
  if (!apiKey) return { error: 'GOOGLE_STT_API_KEY not set' };

  const audioBase64 = audioBuffer.toString('base64');

  const body = {
    config: {
      encoding: 'WEBM_OPUS',          // Chrome/Android records in WebM Opus natively
      sampleRateHertz: 48000,
      languageCode: 'kn-IN',
      enableAutomaticPunctuation: true,
      model: 'default',               // works with sync recognize; latest_long requires longRunningRecognize
    },
    audio: { content: audioBase64 },
  };

  try {
    const res  = await fetch(
      `https://speech.googleapis.com/v1/speech:recognize?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await res.json();

    if (!res.ok) return { error: data.error?.message || `HTTP ${res.status}` };

    const transcript = (data.results ?? [])
      .map(r => r.alternatives?.[0]?.transcript ?? '')
      .join(' ')
      .trim();

    const confidence = data.results?.[0]?.alternatives?.[0]?.confidence;

    return { transcript: transcript || null, confidence };
  } catch (e) {
    return { error: e.message };
  }
}

// ─── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const form = formidable({ keepExtensions: true, maxFileSize: 25 * 1024 * 1024 });

  form.parse(req, async (err, _fields, files) => {
    if (err) return res.status(500).json({ error: 'Failed to parse upload.' });

    const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;
    if (!audioFile)  return res.status(400).json({ error: 'No audio file received.' });

    // Read once, share between both API calls
    const audioBuffer = fs.readFileSync(audioFile.filepath);

    // Run both in parallel
    const [sarvamResult, googleResult] = await Promise.allSettled([
      callSarvam(audioFile),
      callGoogle(audioBuffer),
    ]);

    const sarvam = sarvamResult.status === 'fulfilled' ? sarvamResult.value : { error: sarvamResult.reason?.message };
    const google = googleResult.status === 'fulfilled' ? googleResult.value : { error: googleResult.reason?.message };

    return res.status(200).json({ sarvam, google });
  });
}
