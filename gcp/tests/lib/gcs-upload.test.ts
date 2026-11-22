import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { issueUploadToken, MAX_UPLOAD_BYTES } from '../../lib/upload-grant.js';

const mocks = vi.hoisted(() => ({ file: vi.fn(), metadata: vi.fn(), stream: vi.fn(), policy: vi.fn(), remove: vi.fn() }));
vi.mock('@google-cloud/storage', () => ({ Storage: class { bucket() { return { file: mocks.file }; } } }));
import { createUploadGrant, readAuthorizedUpload, deleteUploadGeneration } from '../../lib/gcs.js';

const grant = { bucket: process.env.GCS_BUCKET || 'your-image-bucket', objectPath: 'uploads/12345678-1234-4123-8123-123456789abc', filename: 'image.jpg', contentType: 'image/jpeg', size: 3 };
const generation = '1741234567890123';
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('UPLOAD_TOKEN_SECRET', randomBytes(32).toString('hex'));
  mocks.file.mockReturnValue({ getMetadata: mocks.metadata, createReadStream: mocks.stream, generateSignedPostPolicyV4: mocks.policy, delete: mocks.remove });
  mocks.metadata.mockResolvedValue([{ size: '3', contentType: 'image/jpeg', generation }]);
  mocks.stream.mockImplementation(() => Readable.from([Buffer.from([0xff, 0xd8, 0xff])]));
  mocks.policy.mockResolvedValue([{ url: 'https://example.invalid', fields: { key: 'test' } }]);
  mocks.remove.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

it('signs an exact object policy with a storage-enforced size bound', async () => {
  const response = await createUploadGrant(grant);
  expect(response.uploadToken).toBeTypeOf('string');
  expect(mocks.file.mock.calls[0][0]).toMatch(/^uploads\/[0-9a-f-]{36}$/);
  expect(mocks.policy).toHaveBeenCalledWith({
    expires: expect.any(Number), conditions: [['content-length-range', 1, 3]],
    fields: { 'Content-Type': 'image/jpeg', success_action_status: '204' },
  });
});
it('performs no storage operation for an invalid token or missing secret', async () => {
  await expect(readAuthorizedUpload('invalid')).rejects.toMatchObject({ status: 403 });
  vi.stubEnv('UPLOAD_TOKEN_SECRET', '');
  await expect(createUploadGrant(grant)).rejects.toMatchObject({ status: 503 });
  expect(mocks.file).not.toHaveBeenCalled();
});
it('pins the read and delete to the authorized generation without rounding', async () => {
  const upload = await readAuthorizedUpload(await issueUploadToken(grant));
  expect(mocks.file).toHaveBeenCalledWith(grant.objectPath, { generation });
  expect(mocks.stream).toHaveBeenCalledWith({ decompress: false });
  await deleteUploadGeneration(upload);
  expect(mocks.file).toHaveBeenLastCalledWith(grant.objectPath, { generation, preconditionOpts: { ifGenerationMatch: generation } });
  expect(mocks.remove).toHaveBeenCalledWith({ ignoreNotFound: true });
});
it.each([
  { size: String(MAX_UPLOAD_BYTES + 1) }, { size: '2' }, { size: 'invalid' },
  { contentType: 'image/png' }, { contentEncoding: 'gzip' }, { generation: undefined }, { generation: '90071992547409931234' },
])('rejects invalid object metadata before reading %j', async metadata => {
  mocks.metadata.mockResolvedValue([{ size: '3', contentType: 'image/jpeg', generation, ...metadata }]);
  await expect(readAuthorizedUpload(await issueUploadToken(grant))).rejects.toThrow();
  expect(mocks.stream).not.toHaveBeenCalled();
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('stops a stream exceeding its grant without retaining subsequent chunks', async () => {
  const stream = Readable.from([Buffer.alloc(3), Buffer.alloc(1), Buffer.alloc(100)]);
  mocks.stream.mockReturnValue(stream);
  await expect(readAuthorizedUpload(await issueUploadToken(grant))).rejects.toMatchObject({ status: 413 });
  expect(stream.destroyed).toBe(true);
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('rejects truncated and failed streams without deleting the input', async () => {
  mocks.stream.mockReturnValueOnce(Readable.from([Buffer.alloc(2)]));
  const token = await issueUploadToken(grant);
  await expect(readAuthorizedUpload(token)).rejects.toMatchObject({ status: 400 });
  mocks.stream.mockReturnValueOnce(Readable.from((async function* () { yield Buffer.alloc(1); throw new Error('Synthetic stream failure'); })()));
  await expect(readAuthorizedUpload(token)).rejects.toThrow('Synthetic stream failure');
  expect(mocks.remove).not.toHaveBeenCalled();
});
it('returns a conflict when the authorized generation disappears during the read', async () => {
  mocks.stream.mockReturnValue(Readable.from((async function* () { throw Object.assign(new Error('replaced'), { code: 412 }); })()));
  await expect(readAuthorizedUpload(await issueUploadToken(grant))).rejects.toMatchObject({ status: 409 });
  expect(mocks.remove).not.toHaveBeenCalled();
});
