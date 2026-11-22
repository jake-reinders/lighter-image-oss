import { Storage } from '@google-cloud/storage';
import { v4 as uuidv4 } from 'uuid';
import {
  MAX_UPLOAD_BYTES, UPLOAD_TTL_SECONDS, UploadError, issueUploadToken,
  verifyUploadToken, normalizeImageType, isRecord, parseUploadRequest, type UploadGrant,
} from './upload-grant.js';

const storage = new Storage();
const BUCKET_NAME = process.env.GCS_BUCKET || 'your-image-bucket';
const bucket = storage.bucket(BUCKET_NAME);

const DOWNLOAD_URL_EXPIRATION = 60 * 60 * 1000;

export async function createUploadGrant(value: unknown) {
  const request = parseUploadRequest(value);
  const grant = { ...request, bucket: BUCKET_NAME, objectPath: `uploads/${uuidv4()}` };
  const uploadToken = await issueUploadToken(grant);
  const [upload] = await bucket.file(grant.objectPath).generateSignedPostPolicyV4({
    expires: Date.now() + UPLOAD_TTL_SECONDS * 1000,
    conditions: [['content-length-range', 1, request.size]],
    fields: { 'Content-Type': request.contentType, success_action_status: '204' },
  });
  return { upload, uploadToken };
}

/**
 * Generate a signed URL for downloading a file from GCS
 */
export async function generateDownloadUrl(objectPath: string): Promise<string> {
  const [signedUrl] = await bucket.file(objectPath).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + DOWNLOAD_URL_EXPIRATION,
  });

  return signedUrl;
}

export interface AuthorizedUpload {
  grant: UploadGrant;
  generation: string;
  buffer: Buffer;
}

export async function readAuthorizedUpload(token: unknown): Promise<AuthorizedUpload> {
  const grant = await verifyUploadToken(token, BUCKET_NAME);
  try {
    const [metadata] = await bucket.file(grant.objectPath).getMetadata();
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) {
      throw new UploadError(413, 'Stored object exceeds the upload limit');
    }
    if (size !== grant.size || normalizeImageType(metadata.contentType) !== grant.contentType || metadata.contentEncoding) {
      throw new UploadError(400, 'Stored object does not match its upload grant');
    }
    if (typeof metadata.generation !== 'string' || !/^[1-9]\d*$/.test(metadata.generation)) {
      throw new UploadError(409, 'Object version is unavailable');
    }
    const generation = metadata.generation;
    // The SDK converts generations to numbers internally; never let it round one.
    if (!Number.isSafeInteger(Number(generation)) || String(Number(generation)) !== generation) {
      throw new UploadError(409, 'Object version cannot be represented safely by the storage client');
    }
    const stream = bucket.file(grant.objectPath, { generation }).createReadStream({ decompress: false });
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new UploadError(400, 'Invalid upload stream');
      bytes += chunk.length;
      if (bytes > grant.size || bytes > MAX_UPLOAD_BYTES) {
        stream.destroy();
        throw new UploadError(413, 'Upload stream exceeds its permitted size');
      }
      chunks.push(chunk);
    }
    if (bytes !== grant.size) throw new UploadError(400, 'Incomplete upload');
    return { grant, generation, buffer: Buffer.concat(chunks, bytes) };
  } catch (error) {
    if (isRecord(error) && error.code === 404) throw new UploadError(404, 'Upload is unavailable');
    if (isRecord(error) && error.code === 412) throw new UploadError(409, 'Upload changed; start a new upload');
    throw error;
  }
}

/**
 * Upload a buffer to GCS
 */
export async function uploadFile(
  objectPath: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  await bucket.file(objectPath).save(buffer, {
    contentType,
    resumable: false,
  });
}

export async function deleteUploadGeneration(upload: AuthorizedUpload): Promise<void> {
  await bucket.file(upload.grant.objectPath, {
    generation: upload.generation,
    preconditionOpts: { ifGenerationMatch: upload.generation },
  }).delete({ ignoreNotFound: true });
}

/**
 * Delete all files older than the specified age
 */
export async function deleteOldFiles(maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  let deletedCount = 0;

  const [files] = await bucket.getFiles({ prefix: 'uploads/' });

  for (const file of files) {
    const [metadata] = await file.getMetadata();
    const created = new Date(metadata.timeCreated as string);

    if (created < cutoff) {
      await file.delete({ ignoreNotFound: true });
      deletedCount++;
    }
  }

  // Also clean up compressed files
  const [compressedFiles] = await bucket.getFiles({ prefix: 'compressed/' });

  for (const file of compressedFiles) {
    const [metadata] = await file.getMetadata();
    const created = new Date(metadata.timeCreated as string);

    if (created < cutoff) {
      await file.delete({ ignoreNotFound: true });
      deletedCount++;
    }
  }

  return deletedCount;
}
