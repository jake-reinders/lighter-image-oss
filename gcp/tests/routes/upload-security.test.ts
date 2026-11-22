import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { issueUploadToken, MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS } from '../../lib/upload-grant.js';

const mocks = vi.hoisted(() => ({ file: vi.fn(), metadata: vi.fn(), stream: vi.fn(), policy: vi.fn(), save: vi.fn(), remove: vi.fn(), url: vi.fn() }));
vi.mock('@google-cloud/storage', () => ({ Storage: class { bucket() { return { file: mocks.file }; } } }));
vi.mock('../../lib/compress.js', async original => ({
  ...await original<typeof import('../../lib/compress.js')>(),
  compressImage: vi.fn(),
}));
import { compressImage } from '../../lib/compress.js';
import { compressRouter } from '../../routes/compress.js';
import { signedUrlRouter } from '../../routes/signed-url.js';

const app = express();
app.use(express.json());
app.use('/compress', compressRouter);
app.use('/signed-url', signedUrlRouter);
const grant = { bucket: process.env.GCS_BUCKET || 'your-image-bucket', objectPath: 'uploads/12345678-1234-4123-8123-123456789abc', filename: 'image.jpg', contentType: 'image/jpeg', size: 3 };
const generation = '1741234567890123';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('UPLOAD_TOKEN_SECRET', randomBytes(32).toString('hex'));
  mocks.file.mockReturnValue({ getMetadata: mocks.metadata, createReadStream: mocks.stream, generateSignedPostPolicyV4: mocks.policy, save: mocks.save, delete: mocks.remove, getSignedUrl: mocks.url });
  mocks.metadata.mockResolvedValue([{ size: '3', contentType: 'image/jpeg', generation }]);
  mocks.stream.mockImplementation(() => Readable.from([Buffer.from([0xff, 0xd8, 0xff])]));
  mocks.policy.mockResolvedValue([{ url: 'https://example.invalid', fields: {} }]);
  mocks.url.mockResolvedValue(['https://example.invalid/download']);
  mocks.save.mockResolvedValue(undefined);
  mocks.remove.mockResolvedValue([]);
  vi.mocked(compressImage).mockResolvedValue({ buffer: Buffer.from('output'), webpBuffer: Buffer.from('webp'), format: 'jpeg', originalSize: 3, compressedSize: 6, webpSize: 4, savingsPercent: 0, webpSavingsPercent: 0, alreadyOptimal: false });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each([null, {}, { objectPath: 'compressed/other.jpg', filename: 'image.jpg' }, { uploadToken: 'forged' }])('rejects unauthorized compression without storage access %j', async body => {
  const response = await request(app).post('/compress').send(body);
  expect(response.status).toBe(403);
  expect(mocks.file).not.toHaveBeenCalled();
  expect(compressImage).not.toHaveBeenCalled();
});
it('does not let a valid grant authorize a caller-supplied object path', async () => {
  const uploadToken = await issueUploadToken(grant);
  const res = await request(app).post('/compress').send({ uploadToken, objectPath: 'compressed/other.jpg' });
  expect(res.status).toBe(403);
  expect(mocks.file).not.toHaveBeenCalled();
});
it('rejects an expired grant before storage access', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const uploadToken = await issueUploadToken(grant);
  vi.advanceTimersByTime(UPLOAD_TTL_SECONDS * 1000);
  expect((await request(app).post('/compress').send({ uploadToken })).status).toBe(403);
  expect(mocks.file).not.toHaveBeenCalled();
});
it('fails closed when upload signing is unconfigured', async () => {
  vi.stubEnv('UPLOAD_TOKEN_SECRET', '');
  const res = await request(app).post('/signed-url').send(grant);
  expect(res.status).toBe(503);
  expect(mocks.file).not.toHaveBeenCalled();
});
it.each([0, -1, 1.5, '3', MAX_UPLOAD_BYTES + 1])('rejects invalid upload size %s before policy signing', async size => {
  const res = await request(app).post('/signed-url').send({ ...grant, size });
  expect(res.status).toBe(size === MAX_UPLOAD_BYTES + 1 ? 413 : 400);
  expect(mocks.policy).not.toHaveBeenCalled();
});
it.each([1, MAX_UPLOAD_BYTES])('issues a bounded grant for size %s', async size => {
  const res = await request(app).post('/signed-url').send({ ...grant, size });
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.uploadToken).toBeTypeOf('string');
  expect(mocks.policy.mock.calls[0][0].conditions).toEqual([['content-length-range', 1, size]]);
});
it('processes the authorized input and deletes only its pinned generation', async () => {
  const res = await request(app).post('/compress').send({ uploadToken: await issueUploadToken(grant) });
  expect(res.status).toBe(200);
  expect(res.body.url).toBe('https://example.invalid/download');
  expect(mocks.save).toHaveBeenCalledTimes(2);
  expect(mocks.file).toHaveBeenLastCalledWith(grant.objectPath, { generation, preconditionOpts: { ifGenerationMatch: generation } });
});
it('keeps successful results when deletion loses a race with replacement', async () => {
  mocks.remove.mockRejectedValue(Object.assign(new Error('replacement'), { code: 412 }));
  const res = await request(app).post('/compress').send({ uploadToken: await issueUploadToken(grant) });
  expect(res.status).toBe(200);
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});
it('preserves the input when one output upload fails', async () => {
  mocks.save.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Synthetic output failure'));
  const res = await request(app).post('/compress').send({ uploadToken: await issueUploadToken(grant) });
  expect(res.status).toBe(500);
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('rejects mismatched image bytes without compression or deletion', async () => {
  mocks.stream.mockReturnValue(Readable.from([Buffer.from('abc')]));
  const res = await request(app).post('/compress').send({ uploadToken: await issueUploadToken(grant) });
  expect(res.status).toBe(400);
  expect(compressImage).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('rejects a stream overflow without compression or deletion', async () => {
  mocks.stream.mockReturnValue(Readable.from([Buffer.alloc(4)]));
  const res = await request(app).post('/compress').send({ uploadToken: await issueUploadToken(grant) });
  expect(res.status).toBe(413);
  expect(compressImage).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
