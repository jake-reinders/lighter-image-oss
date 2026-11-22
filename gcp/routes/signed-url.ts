import { Router } from 'express';
import { createUploadGrant } from '../lib/gcs.js';
import { UploadError } from '../lib/upload-grant.js';

export const signedUrlRouter = Router();

signedUrlRouter.post('/', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const grant = await createUploadGrant(req.body);
    return res.json({ success: true, ...grant });
  } catch (error) {
    if (error instanceof UploadError) return res.status(error.status).json({ success: false, error: error.message });
    console.error('Upload grant creation failed');
    return res.status(500).json({ success: false, error: 'Unable to authorize upload' });
  }
});
