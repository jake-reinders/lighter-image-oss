import { randomBytes } from 'node:crypto';
import { SignJWT, decodeJwt } from 'jose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { issueUploadToken, verifyUploadToken, parseUploadRequest, MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS } from '../../lib/upload-grant.js';

const grant = { bucket: 'test-bucket', objectPath: 'uploads/12345678-1234-4123-8123-123456789abc', filename: 'test.jpg', contentType: 'image/jpeg', size: 20 };
beforeEach(() => vi.stubEnv('UPLOAD_TOKEN_SECRET', randomBytes(32).toString('hex')));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each([undefined, null, -1, 0, 1.5, '20', Number.MAX_SAFE_INTEGER])('rejects invalid declared sizes (%s)', size => {
  expect(() => parseUploadRequest({ ...grant, size })).toThrow();
});
it.each([1, MAX_UPLOAD_BYTES])('accepts boundary size %s', size => {
  expect(parseUploadRequest({ ...grant, size }).size).toBe(size);
});
it('normalizes MIME aliases and sanitizes the display filename', () => {
  expect(parseUploadRequest({ filename: '../a.jpg', contentType: 'image/jpg', size: 10 })).toEqual({ filename: '_a.jpg', contentType: 'image/jpeg', size: 10 });
  expect(parseUploadRequest({ ...grant, contentType: 'image/heif' }).contentType).toBe('image/heic');
});
it('verifies a grant only for the configured bucket', async () => {
  const token = await issueUploadToken(grant);
  expect(await verifyUploadToken(token, grant.bucket)).toEqual(grant);
  await expect(verifyUploadToken(token, 'other-bucket')).rejects.toMatchObject({ status: 403 });
});
it('keeps grants valid across a second boundary during issuance', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const boundary = new Date('2026-11-21T12:00:00.999Z').getTime();
  vi.setSystemTime(boundary);
  // The two clock APIs observe opposite sides of the second boundary.
  vi.spyOn(Date, 'now').mockReturnValue(boundary + 1);
  const token = await issueUploadToken(grant);
  vi.setSystemTime(boundary + 1);
  const { iat, exp } = decodeJwt(token);
  expect(exp! - iat!).toBe(UPLOAD_TTL_SECONDS);
  expect(await verifyUploadToken(token, grant.bucket)).toEqual(grant);
});
it('rejects expired tokens', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const token = await issueUploadToken(grant);
  vi.advanceTimersByTime(UPLOAD_TTL_SECONDS * 1000);
  await expect(verifyUploadToken(token, grant.bucket)).rejects.toMatchObject({ status: 403 });
});
it('rejects token tampering and a different signing secret', async () => {
  const token = await issueUploadToken(grant);
  const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url').toString()), objectPath: 'compressed/other.jpg' })).toString('base64url');
  await expect(verifyUploadToken(parts.join('.'), grant.bucket)).rejects.toMatchObject({ status: 403 });
  vi.stubEnv('UPLOAD_TOKEN_SECRET', randomBytes(32).toString('hex'));
  await expect(verifyUploadToken(token, grant.bucket)).rejects.toMatchObject({ status: 403 });
});
it('rejects unsigned tokens even when their claims match a valid grant', async () => {
  const parts = (await issueUploadToken(grant)).split('.');
  parts[0] = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  parts[2] = '';
  await expect(verifyUploadToken(parts.join('.'), grant.bucket)).rejects.toMatchObject({ status: 403 });
});
it.each([
  { purpose: 'download' }, { objectPath: 'compressed/other.jpg' }, { size: MAX_UPLOAD_BYTES + 1 },
  { filename: '../test.jpg' }, { contentType: 'text/html' }, { bucket: 'other-bucket' },
])('rejects correctly signed but invalid claims %j', async override => {
  const token = await new SignJWT({ ...grant, purpose: 'compress', ...override })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setIssuer('lighter-image-oss')
    .setAudience('image-compression').setIssuedAt().setExpirationTime('15m')
    .sign(Buffer.from(process.env.UPLOAD_TOKEN_SECRET!, 'hex'));
  await expect(verifyUploadToken(token, grant.bucket)).rejects.toMatchObject({ status: 403 });
});
it.each(['', 'short', 'x'.repeat(64)])('fails closed for invalid configuration', async secret => {
  vi.stubEnv('UPLOAD_TOKEN_SECRET', secret);
  await expect(issueUploadToken(grant)).rejects.toMatchObject({ status: 503 });
  await expect(verifyUploadToken('anything', grant.bucket)).rejects.toMatchObject({ status: 503 });
});

it.each([{ iss: 'other-service' }, { aud: 'download' }, { exp: undefined }])('rejects invalid standard claims %j', async override => {
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ ...grant, purpose: 'compress', iss: 'lighter-image-oss', aud: 'image-compression', iat: now, exp: now + UPLOAD_TTL_SECONDS, ...override })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(Buffer.from(process.env.UPLOAD_TOKEN_SECRET!, 'hex'));
  await expect(verifyUploadToken(token, grant.bucket)).rejects.toMatchObject({ status: 403 });
});
it.each(['future-issue', 'excessive-lifetime'])('rejects %s', async mode => {
  const now = Math.floor(Date.now() / 1000);
  const issued = mode === 'future-issue' ? now + 60 : now;
  const token = await new SignJWT({ ...grant, purpose: 'compress', iss: 'lighter-image-oss', aud: 'image-compression', iat: issued, exp: mode === 'future-issue' ? issued + UPLOAD_TTL_SECONDS : now + UPLOAD_TTL_SECONDS * 2 })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(Buffer.from(process.env.UPLOAD_TOKEN_SECRET!, 'hex'));
  await expect(verifyUploadToken(token, grant.bucket)).rejects.toMatchObject({ status: 403 });
});
