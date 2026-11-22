import type { VercelRequest, VercelResponse } from '../../lib/http.js';
import { callCloudRun } from '../../lib/gcp-auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ success: false, error: 'Expected a JSON object' });
  }
  const { filename, contentType, size } = req.body as Record<string, unknown>;
  if (typeof filename !== 'string' || !filename || typeof contentType !== 'string' || !contentType) {
    return res.status(400).json({ success: false, error: 'Missing filename or contentType' });
  }
  try {
    const response = await callCloudRun('/signed-url', { body: { filename, contentType, size } });
    return res.status(response.status).json(await response.json());
  } catch {
    console.error('Upload grant proxy request failed');
    return res.status(500).json({ success: false, error: 'Upload service unavailable' });
  }
}
