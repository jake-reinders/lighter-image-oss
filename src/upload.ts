export interface GCSUploadResult {
  uploadToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function uploadToGCS(file: File): Promise<GCSUploadResult> {
  const response = await fetch('/api/gcp/signed-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, contentType: file.type, size: file.size }),
  });
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new Error(isRecord(result) && typeof result.error === 'string' ? result.error : 'Unable to authorize upload');
  }
  if (!isRecord(result) || typeof result.uploadToken !== 'string' || !result.uploadToken ||
      !isRecord(result.upload) || typeof result.upload.url !== 'string' ||
      !isRecord(result.upload.fields) || !Object.values(result.upload.fields).every(value => typeof value === 'string')) {
    throw new Error('Invalid upload grant response');
  }
  const url = new URL(result.upload.url);
  if (url.protocol !== 'https:') throw new Error('An HTTPS storage endpoint is required');
  const form = new FormData();
  for (const [key, value] of Object.entries(result.upload.fields)) form.append(key, String(value));
  form.append('file', file);
  const upload = await fetch(url.href, { method: 'POST', body: form });
  if (!upload.ok) throw new Error(`Storage rejected the upload (${upload.status})`);
  return { uploadToken: result.uploadToken };
}
