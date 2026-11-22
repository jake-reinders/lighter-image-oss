import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { uploadToGCS } from '../src/upload.js';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it('posts policy fields with the File last, and returns only the upload token', async () => {
  const file = new File(['test'], 'image.jpg', { type: 'image/jpeg' });
  const arrayBuffer = vi.spyOn(file, 'arrayBuffer').mockRejectedValue(new Error('Unnecessary file copy'));
  mockFetch.mockResolvedValueOnce(Response.json({ uploadToken: 'synthetic-token', upload: { url: 'https://storage.example.invalid/upload', fields: { key: 'uploads/test', policy: 'synthetic-policy', 'Content-Type': 'image/jpeg' } } })).mockResolvedValueOnce(new Response(null, { status: 204 }));
  expect(await uploadToGCS(file)).toEqual({ uploadToken: 'synthetic-token' });
  expect(arrayBuffer).not.toHaveBeenCalled();
  expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ filename: 'image.jpg', contentType: 'image/jpeg', size: 4 });
  const options = mockFetch.mock.calls[1][1];
  expect(options.method).toBe('POST');
  expect(options.headers).toBeUndefined();
  expect([...options.body.keys()]).toEqual(['key', 'policy', 'Content-Type', 'file']);
  expect(options.body.get('file')).toBe(file);
});
it('does not return the token if storage rejects the file', async () => {
  mockFetch.mockResolvedValueOnce(Response.json({ uploadToken: 'synthetic', upload: { url: 'https://example.invalid', fields: {} } })).mockResolvedValueOnce(new Response(null, { status: 400 }));
  await expect(uploadToGCS(new File(['test'], 'test.jpg', { type: 'image/jpeg' }))).rejects.toThrow('Storage rejected');
});
it('rejects insecure or malformed storage responses before sending the image', async () => {
  mockFetch.mockResolvedValue(Response.json({ uploadToken: 'synthetic', upload: { url: 'http://example.invalid', fields: {} } }));
  await expect(uploadToGCS(new File(['test'], 'test.jpg'))).rejects.toThrow('HTTPS');
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
