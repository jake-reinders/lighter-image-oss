import { randomBytes, randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../../lib/upload-grant.js';

const enabled = process.env.RUN_GCS_POLICY_TESTS === '1';

it.skipIf(!enabled)('enforces upload policy bounds and preserves replacement objects in a disposable bucket', async () => {
  const name = process.env.GCS_POLICY_TEST_BUCKET;
  if (!name) throw new Error('GCS_POLICY_TEST_BUCKET must name your disposable test bucket');
  vi.stubEnv('GCS_BUCKET', name);
  vi.stubEnv('UPLOAD_TOKEN_SECRET', randomBytes(32).toString('hex'));
  const bucket = new Storage().bucket(name);
  const { createUploadGrant, readAuthorizedUpload, deleteUploadGeneration } = await import('../../lib/gcs.js');
  const paths: string[] = [];
  async function post(upload: { url: string; fields: Record<string, string> }, size: number, key?: string) {
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, name === 'key' && key ? key : value);
    form.append('file', new Blob([Buffer.alloc(size)], { type: 'image/jpeg' }), 'synthetic.jpg');
    return fetch(upload.url, { method: 'POST', body: form });
  }
  try {
    const grant = await createUploadGrant({ filename: 'synthetic.jpg', contentType: 'image/jpeg', size: MAX_UPLOAD_BYTES });
    paths.push(grant.upload.fields.key);
    expect((await post(grant.upload, MAX_UPLOAD_BYTES)).ok).toBe(true);
    const oversized = await post(grant.upload, MAX_UPLOAD_BYTES + 1);
    expect(oversized.ok).toBe(false);
    expect(await oversized.text()).toMatch(/EntityTooLarge|content-length-range|larger.*allowed|maximum.*size/i);
    expect((await bucket.file(grant.upload.fields.key).getMetadata())[0].size).toBe(String(MAX_UPLOAD_BYTES));
    const otherPath = `uploads/${randomUUID()}`;
    paths.push(otherPath);
    expect((await post(grant.upload, MAX_UPLOAD_BYTES, otherPath)).ok).toBe(false);
    expect((await bucket.file(otherPath).exists())[0]).toBe(false);

    const small = await createUploadGrant({ filename: 'small.jpg', contentType: 'image/jpeg', size: 1 });
    paths.push(small.upload.fields.key);
    expect((await post(small.upload, 1)).ok).toBe(true);
    const original = await readAuthorizedUpload(small.uploadToken);
    await bucket.file(small.upload.fields.key).save('replacement', { resumable: false });
    await deleteUploadGeneration(original).catch(error => {
      if (!error || error.code !== 412) throw error;
    });
    expect((await bucket.file(small.upload.fields.key).download())[0].toString()).toBe('replacement');
  } finally {
    try {
      for (const path of paths) {
        const file = bucket.file(path);
        const [exists] = await file.exists();
        if (exists) {
          const [metadata] = await file.getMetadata();
          await bucket.file(path, { generation: metadata.generation }).delete({ ignoreNotFound: true });
        }
      }
    } finally { vi.unstubAllEnvs(); }
  }
}, 120_000);
