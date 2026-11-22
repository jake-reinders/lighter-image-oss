import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import compress from '../../api/gcp/compress.js';
import signedUrl from '../../api/gcp/signed-url.js';
import { callCloudRun } from '../../lib/gcp-auth.js';

vi.mock('../../lib/gcp-auth.js', () => ({ callCloudRun: vi.fn() }));

function request(body: unknown) {
  const req = Object.assign(new IncomingMessage(new Socket()), { method: 'POST', body });
  const res = Object.assign(new ServerResponse(req), {
    status(code: number) { this.statusCode = code; return this; },
    json: vi.fn(),
  });
  return { req, res };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(callCloudRun).mockResolvedValue(Response.json({ success: true }));
});

describe.each([['compression', compress], ['upload signing', signedUrl]] as const)('%s proxy', (_name, handler) => {
  it.each([null, [], 'invalid'])('rejects a malformed body (%s)', async body => {
    const { req, res } = request(body);
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(callCloudRun).not.toHaveBeenCalled();
  });
});

it('forwards compression options without client tracking fields', async () => {
  const options = { uploadToken: 'synthetic-token', outputFormat: 'original', resize: { type: 'none' } };
  const { req, res } = request({ ...options, objectPath: 'compressed/other.jpg', filename: 'other.jpg', clientIp: 'synthetic' });
  await compress(req, res);
  expect(res.statusCode).toBe(200);
  expect(callCloudRun).toHaveBeenCalledExactlyOnceWith('/compress', { body: options });
});

it('forwards upload metadata', async () => {
  const body = { filename: 'image.jpg', contentType: 'image/jpeg', size: 100 };
  const { req, res } = request(body);
  await signedUrl(req, res);
  expect(callCloudRun).toHaveBeenCalledExactlyOnceWith('/signed-url', { body });
});
