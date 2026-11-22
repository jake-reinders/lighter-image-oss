import { SignJWT, jwtVerify } from 'jose';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const UPLOAD_TTL_SECONDS = 15 * 60;
const ISSUER = 'lighter-image-oss';
const AUDIENCE = 'image-compression';
const UPLOAD_PATH = /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/avif', 'image/heic']);

export class UploadError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeImageType(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const type = value.toLowerCase();
  const normalized = type === 'image/jpg' ? 'image/jpeg' : type === 'image/heif' ? 'image/heic' : type;
  return MIME_TYPES.has(normalized) ? normalized : undefined;
}

export interface UploadRequest {
  filename: string;
  contentType: string;
  size: number;
}

export interface UploadGrant extends UploadRequest {
  bucket: string;
  objectPath: string;
}

export function parseUploadRequest(value: unknown): UploadRequest {
  if (!isRecord(value) || typeof value.filename !== 'string' || !value.filename || value.filename.length > 255) {
    throw new UploadError(400, 'A filename of 1–255 characters is required');
  }
  const contentType = normalizeImageType(value.contentType);
  if (!contentType) throw new UploadError(400, 'Unsupported image type');
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size < 1) {
    throw new UploadError(400, 'A positive integer file size is required');
  }
  if (value.size > MAX_UPLOAD_BYTES) throw new UploadError(413, 'Maximum file size is 10 MiB');
  const filename = value.filename.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '') || 'image';
  return { filename, contentType, size: value.size };
}

export function validateUploadConfig(): Buffer {
  const secret = process.env.UPLOAD_TOKEN_SECRET;
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) {
    throw new UploadError(503, 'Upload authorization is not configured');
  }
  return Buffer.from(secret, 'hex');
}

export async function issueUploadToken(grant: UploadGrant): Promise<string> {
  const key = validateUploadConfig();
  const issuedAt = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...grant, purpose: 'compress' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + UPLOAD_TTL_SECONDS)
    .sign(key);
}

export async function verifyUploadToken(token: unknown, bucket: string): Promise<UploadGrant> {
  const key = validateUploadConfig();
  if (typeof token !== 'string' || !token || token.length > 4096) {
    throw new UploadError(403, 'Invalid or expired upload token');
  }
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'], typ: 'JWT', issuer: ISSUER, audience: AUDIENCE,
      requiredClaims: ['iat', 'exp'],
    });
    if (payload.purpose !== 'compress' || payload.bucket !== bucket ||
        typeof payload.objectPath !== 'string' || !UPLOAD_PATH.test(payload.objectPath) ||
        typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
        payload.exp <= payload.iat || payload.exp - payload.iat > UPLOAD_TTL_SECONDS ||
        payload.iat > Math.floor(Date.now() / 1000) + 5) {
      throw new Error('Invalid claims');
    }
    const metadata = parseUploadRequest(payload);
    if (metadata.filename !== payload.filename || metadata.contentType !== payload.contentType) throw new Error('Invalid metadata');
    return { ...metadata, bucket, objectPath: payload.objectPath };
  } catch {
    throw new UploadError(403, 'Invalid or expired upload token');
  }
}
