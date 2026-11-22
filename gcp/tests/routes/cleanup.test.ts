import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../../lib/gcs.js', () => ({ deleteOldFiles: vi.fn().mockResolvedValue(2) }));
import { deleteOldFiles } from '../../lib/gcs.js';
import { cleanupRouter } from '../../routes/cleanup.js';

const app = express();
app.use(express.json());
app.use('/cleanup', cleanupRouter);
const day = 24 * 60 * 60 * 1000;

describe('cleanup authorization and retention', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CLEANUP_SECRET', 'test-cleanup-secret'); });
  afterEach(() => vi.unstubAllEnvs());

  it('fails closed when no secret is configured', async () => {
    vi.stubEnv('CLEANUP_SECRET', '');
    expect((await request(app).post('/cleanup')).status).toBe(503);
    expect(deleteOldFiles).not.toHaveBeenCalled();
  });

  it.each(['', 'wrong-secret'])('rejects an unauthorized caller (%s)', async secret => {
    expect((await request(app).post('/cleanup').set('X-Cleanup-Secret', secret)).status).toBe(401);
    expect(deleteOldFiles).not.toHaveBeenCalled();
  });

  it.each([-1, 0, day - 1, '86400000', 1.5])('rejects unsafe retention (%s)', async maxAgeMs => {
    const res = await request(app).post('/cleanup').set('X-Cleanup-Secret', 'test-cleanup-secret').send({ maxAgeMs });
    expect(res.status).toBe(400);
    expect(deleteOldFiles).not.toHaveBeenCalled();
  });

  it('allows authenticated cleanup with the default retention', async () => {
    const res = await request(app).post('/cleanup').set('X-Cleanup-Secret', 'test-cleanup-secret').send({});
    expect(res.status).toBe(200);
    expect(deleteOldFiles).toHaveBeenCalledWith(day);
  });
});
