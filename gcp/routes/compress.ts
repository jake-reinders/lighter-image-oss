import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  readAuthorizedUpload,
  uploadFile,
  deleteUploadGeneration,
  generateDownloadUrl,
} from '../lib/gcs.js';
import { compressImage, validateMagicBytes, type ResizeOptions } from '../lib/compress.js';
import { UploadError, isRecord, normalizeImageType } from '../lib/upload-grant.js';

export const compressRouter = Router();

function getUserFriendlyError(rawMessage: string): string {
  const errorMappings: Array<{ pattern: RegExp; message: string }> = [
    {
      pattern: /premature end of input|unexpected end of file|truncated/i,
      message: 'The image file appears to be incomplete or corrupted. Please try uploading again.',
    },
    {
      pattern: /unsupported image format|invalid image|not a valid/i,
      message: 'This image format is not supported. Please use PNG, JPG, WebP, BMP, AVIF, or HEIC.',
    },
    {
      pattern: /out of memory|memory allocation/i,
      message: 'This image is too large to process. Please try a smaller image or reduce its dimensions.',
    },
    {
      pattern: /timeout|timed out/i,
      message: 'Processing took too long. Please try a smaller image.',
    },
    {
      pattern: /HEIC conversion failed/i,
      message: 'Failed to process HEIC image. The file may be corrupted or in an unsupported HEIC variant.',
    },
    {
      pattern: /too large for the WebP format|exceeds? (?:the )?(?:WebP|webp)/i,
      message: 'This image is too large for WebP conversion. Please try a smaller image or reduce its dimensions.',
    },
  ];

  for (const { pattern, message } of errorMappings) {
    if (pattern.test(rawMessage)) {
      return message;
    }
  }

  return 'Something went wrong while processing your image. Please try again.';
}

interface CompressRequest {
  uploadToken: string;
  outputFormat?: 'original' | 'webp-only';
  resize?: ResizeOptions;
}

function parseCompressRequest(value: unknown): CompressRequest {
  if (!isRecord(value) || Object.keys(value).some(key => !['uploadToken', 'outputFormat', 'resize'].includes(key)) ||
      typeof value.uploadToken !== 'string' || !value.uploadToken || value.uploadToken.length > 4096) {
    throw new UploadError(403, 'A valid upload token is required');
  }
  if (value.outputFormat !== undefined && value.outputFormat !== 'original' && value.outputFormat !== 'webp-only') {
    throw new UploadError(400, 'Invalid output format');
  }
  let resize: ResizeOptions | undefined;
  if (value.resize !== undefined) {
    const option = value.resize;
    if (!isRecord(option)) throw new UploadError(400, 'Invalid resize options');
    if (option.type === 'none') resize = { type: 'none' };
    else {
      if ((option.type !== 'preset' && option.type !== 'custom') ||
          (option.unit !== 'px' && option.unit !== '%') ||
          typeof option.value !== 'number' || !Number.isFinite(option.value) || option.value <= 0 ||
          option.value > (option.unit === '%' ? 100 : 16384) ||
          (option.unit === 'px' && !Number.isInteger(option.value))) {
        throw new UploadError(400, 'Invalid resize options');
      }
      resize = { type: option.type, unit: option.unit, value: option.value };
    }
  }
  return { uploadToken: value.uploadToken, outputFormat: value.outputFormat, resize };
}

compressRouter.post('/', async (req, res) => {
  const startTime = Date.now();
  res.setHeader('Cache-Control', 'no-store');

  try {

    const body = parseCompressRequest(req.body);
    const outputFormat = body.outputFormat || 'original';
    const resize = body.resize;
    const fetchStart = Date.now();
    const upload = await readAuthorizedUpload(body.uploadToken);
    const inputBuffer = upload.buffer;
    const filename = upload.grant.filename;
    console.log(JSON.stringify({
      event: 'compress_timing',
      phase: 'gcs_fetch',
      duration: Date.now() - fetchStart,
      size: inputBuffer.length,
    }));

    const detectedType = validateMagicBytes(inputBuffer);
    const genericHeif = inputBuffer.subarray(8, 12).toString('ascii') === 'mif1';
    const matchingType = normalizeImageType(detectedType) === upload.grant.contentType ||
      (genericHeif && ['image/heic', 'image/avif'].includes(upload.grant.contentType));
    if (!detectedType || !matchingType) {
      return res.status(400).json({
        success: false,
        error: 'Invalid image format. File content does not match a supported image type.',
      });
    }

    console.log(JSON.stringify({
      event: 'compression_start',
      inputSize: inputBuffer.length,
      detectedType,
      filename,
      timestamp: new Date().toISOString(),
    }));

    const result = await compressImage(inputBuffer, resize);

    const uuid = uuidv4();
    const baseName = filename.replace(/\.[^/.]+$/, '');
    const primaryExt = result.format === 'jpeg' ? '.jpg' : result.format === 'avif' ? '.avif' : '.png';
    const primaryContentType = result.format === 'jpeg' ? 'image/jpeg' : result.format === 'avif' ? 'image/avif' : 'image/png';

    let primaryUrl: string | null = null;
    let webpUrl: string | null = null;

    const uploadStart = Date.now();

    if (outputFormat === 'webp-only') {
      const webpPath = `compressed/${baseName}-compressed-${uuid}.webp`;
      await uploadFile(webpPath, result.webpBuffer, 'image/webp');
      webpUrl = await generateDownloadUrl(webpPath);
    } else {
      const primaryPath = `compressed/${baseName}-compressed-${uuid}${primaryExt}`;
      const webpPath = `compressed/${baseName}-compressed-${uuid}.webp`;

      await Promise.all([
        uploadFile(primaryPath, result.buffer, primaryContentType),
        uploadFile(webpPath, result.webpBuffer, 'image/webp'),
      ]);

      [primaryUrl, webpUrl] = await Promise.all([
        generateDownloadUrl(primaryPath),
        generateDownloadUrl(webpPath),
      ]);
    }

    console.log(JSON.stringify({
      event: 'compress_timing',
      phase: 'gcs_upload',
      duration: Date.now() - uploadStart,
    }));

    await deleteUploadGeneration(upload).catch(() => {
      console.error('Input cleanup deferred to retention cleanup');
    });

    const duration = Date.now() - startTime;

    console.log(JSON.stringify({
      event: 'compression_complete',
      inputSize: result.originalSize,
      outputSize: result.compressedSize,
      webpSize: result.webpSize,
      savingsPercent: result.savingsPercent,
      format: result.format,
      outputFormat,
      duration,
      timestamp: new Date().toISOString(),
    }));

    return res.json({
      success: true,
      outputFormat,
      url: primaryUrl,
      filename: primaryUrl ? `${baseName}-compressed${primaryExt}` : null,
      format: result.format,
      compressedSize: primaryUrl ? result.compressedSize : null,
      savingsPercent: primaryUrl ? result.savingsPercent : null,
      webpUrl,
      webpFilename: `${baseName}-compressed.webp`,
      webpSize: result.webpSize,
      webpSavingsPercent: result.webpSavingsPercent,
      originalSize: result.originalSize,
      alreadyOptimal: result.alreadyOptimal,
    });
  } catch (error) {
    if (error instanceof UploadError) return res.status(error.status).json({ success: false, error: error.message });
    const duration = Date.now() - startTime;
    const rawMessage = error instanceof Error ? error.message : 'Compression failed';

    console.log(JSON.stringify({
      event: 'compression_error',
      duration,
      timestamp: new Date().toISOString(),
    }));

    const userMessage = getUserFriendlyError(rawMessage);

    return res.status(500).json({
      success: false,
      error: userMessage,
    });
  }
});
