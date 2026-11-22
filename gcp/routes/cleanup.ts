import { Router } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { deleteOldFiles } from '../lib/gcs.js';

export const cleanupRouter = Router();

// Default: delete files older than 24 hours
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

cleanupRouter.post('/', async (req, res) => {
  const secret = process.env.CLEANUP_SECRET;
  if (!secret) return res.status(503).json({ success: false, error: 'Cleanup is not configured' });
  const supplied = req.get('X-Cleanup-Secret') || '';
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!supplied || !timingSafeEqual(digest(supplied), digest(secret))) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  const maxAgeMs = req.body?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < DEFAULT_MAX_AGE_MS) {
    return res.status(400).json({ success: false, error: 'Retention must be at least 24 hours in integer milliseconds' });
  }
  const startTime = Date.now();

  try {

    console.log(JSON.stringify({
      event: 'cleanup_start',
      maxAgeMs,
      timestamp: new Date().toISOString(),
    }));

    const deletedCount = await deleteOldFiles(maxAgeMs);

    const duration = Date.now() - startTime;

    console.log(JSON.stringify({
      event: 'cleanup_complete',
      deletedCount,
      duration,
      timestamp: new Date().toISOString(),
    }));

    return res.json({
      success: true,
      deletedCount,
      duration,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cleanup failed';

    console.error(JSON.stringify({
      event: 'cleanup_error',
      error: message,
      timestamp: new Date().toISOString(),
    }));

    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});
