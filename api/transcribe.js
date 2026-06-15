import formidable from 'formidable';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  // CORS headers (useful during local dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'SARVAM_API_KEY environment variable is not set.' });
  }

  // Parse incoming multipart form data
  const form = formidable({ keepExtensions: true, maxFileSize: 25 * 1024 * 1024 }); // 25 MB max

  form.parse(req, async (err, _fields, files) => {
    if (err) {
      console.error('Form parse error:', err);
      return res.status(500).json({ error: 'Failed to parse audio upload.' });
    }

    // formidable v3 wraps files in arrays
    const audioFile = Array.isArray(files.audio) ? files.audio[0] : files.audio;

    if (!audioFile) {
      return res.status(400).json({ error: 'No audio file received.' });
    }

    // Build multipart request for Sarvam STT
    const sarvamForm = new FormData();
    sarvamForm.append('file', fs.createReadStream(audioFile.filepath), {
      filename: audioFile.originalFilename || 'recording.webm',
      contentType: audioFile.mimetype || 'audio/webm',
    });
    sarvamForm.append('language_code', 'kn-IN');
    sarvamForm.append('model', 'saarika:v2');       // saarika:v1 also works
    sarvamForm.append('with_timestamps', 'false');
    sarvamForm.append('with_disfluencies', 'false');

    try {
      const sarvamRes = await fetch('https://api.sarvam.ai/speech-to-text', {
        method: 'POST',
        headers: {
          'api-subscription-key': apiKey,
          ...sarvamForm.getHeaders(),
        },
        body: sarvamForm,
      });

      const rawText = await sarvamRes.text();
      let data;

      try {
        data = JSON.parse(rawText);
      } catch {
        console.error('Non-JSON response from Sarvam:', rawText);
        return res.status(502).json({ error: `Sarvam returned unexpected response: ${rawText.slice(0, 200)}` });
      }

      if (!sarvamRes.ok) {
        console.error('Sarvam API error:', data);
        return res.status(sarvamRes.status).json({
          error: data.message || data.error || `Sarvam API error ${sarvamRes.status}`,
        });
      }

      // Sarvam returns { transcript: "...", language_code: "kn-IN", ... }
      const transcript = data.transcript ?? data.text ?? null;

      if (!transcript) {
        return res.status(200).json({ error: 'Sarvam returned no transcript. Raw response: ' + JSON.stringify(data) });
      }

      return res.status(200).json({ transcript });

    } catch (fetchErr) {
      console.error('Fetch error calling Sarvam:', fetchErr);
      return res.status(502).json({ error: `Could not reach Sarvam API: ${fetchErr.message}` });
    }
  });
}
