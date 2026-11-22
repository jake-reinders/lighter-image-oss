import type { VercelRequest, VercelResponse } from '../lib/http.js';
import { isAuthorizedCron } from '../lib/cron-auth.js';
import { callCloudRun } from '../lib/gcp-auth.js';

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CleanupResult {
  deletedCount: number;
  cutoffDate: string;
}

export async function runCleanup(): Promise<CleanupResult> {
  const cleanupSecret = process.env.CLEANUP_SECRET;
  if (!cleanupSecret) throw new Error('CLEANUP_SECRET is required');
  const now = Date.now();
  const cutoffDate = new Date(now - MAX_AGE_MS);

  const response = await callCloudRun('/cleanup', {
    method: 'POST',
    headers: { 'X-Cleanup-Secret': cleanupSecret },
    body: { maxAgeMs: MAX_AGE_MS },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Cloud Run cleanup failed: ${error}`);
  }

  const data = await response.json();

  console.log(`Cleanup completed: deleted ${data.deletedCount} files older than 24 hours`);

  return {
    deletedCount: data.deletedCount,
    cutoffDate: cutoffDate.toISOString(),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAuthorizedCron(req.headers.authorization)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const result = await runCleanup();
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('Cleanup error:', error);
    const message = error instanceof Error ? error.message : 'Cleanup failed';
    return res.status(500).json({ success: false, error: message });
  }
}
