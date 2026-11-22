import sharp from 'sharp';
import heicConvert from 'heic-convert';

function isHeicBuffer(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  // Check for ftyp box (ISOBMFF container)
  if (buffer[4] !== 0x66 || buffer[5] !== 0x74 ||
      buffer[6] !== 0x79 || buffer[7] !== 0x70) return false;
  const brand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
  return ['heic', 'heix', 'hevc', 'hevx', 'mif1'].includes(brand);
}

export interface ResizeOptions {
  type: 'none' | 'preset' | 'custom';
  value?: number | null;
  unit?: 'px' | '%';
}

export interface ApiCompressOptions {
  quality?: number;
  format?: 'jpeg' | 'png' | 'webp' | 'avif';
}

export interface CompressionResult {
  buffer: Buffer;
  webpBuffer: Buffer;
  format: 'jpeg' | 'png' | 'avif' | 'webp';
  originalSize: number;
  compressedSize: number;
  webpSize: number;
  savingsPercent: number;
  webpSavingsPercent: number;
  alreadyOptimal: boolean;
  width?: number;
  height?: number;
}

export async function compressImage(
  inputBuffer: Buffer,
  resize?: ResizeOptions,
  apiOptions?: ApiCompressOptions
): Promise<CompressionResult> {
  const startTime = Date.now();
  const originalSize = inputBuffer.length;

  // HEIC pre-processing: convert to JPEG before Sharp can process
  let processBuffer = inputBuffer;
  let wasHeic = false;

  if (isHeicBuffer(inputBuffer)) {
    console.log(JSON.stringify({ event: 'heic_convert', phase: 'start', size: inputBuffer.length }));
    const heicStart = Date.now();
    try {
      // The converter accepts Buffer; its declaration requires ArrayBufferLike.
      const jpegArrayBuffer = await heicConvert({
        buffer: inputBuffer as unknown as ArrayBufferLike,
        format: 'JPEG',
        quality: 0.92
      });
      processBuffer = Buffer.from(jpegArrayBuffer);
      wasHeic = true;
      console.log(JSON.stringify({
        event: 'heic_convert',
        phase: 'complete',
        duration: Date.now() - heicStart,
        inputSize: inputBuffer.length,
        outputSize: processBuffer.length
      }));
    } catch (heicError) {
      console.error(JSON.stringify({
        event: 'heic_convert',
        phase: 'error',
        error: heicError instanceof Error ? heicError.message : 'Unknown HEIC conversion error'
      }));
      throw new Error(`HEIC conversion failed: ${heicError instanceof Error ? heicError.message : 'Unknown error'}`);
    }
  }

  const metaStart = Date.now();
  const metadata = await sharp(processBuffer).metadata();
  const stats = await sharp(processBuffer).stats();
  console.log(JSON.stringify({ event: 'compress_timing', phase: 'metadata', duration: Date.now() - metaStart }));

  let resizeWidth: number | undefined;
  let resizeHeight: number | undefined;

  if (resize && resize.type !== 'none' && resize.value) {
    let maxDimension = resize.value;

    if (resize.unit === '%') {
      const largerSide = Math.max(metadata.width || 0, metadata.height || 0);
      maxDimension = Math.round(largerSide * (resize.value / 100));
    }

    const currentMax = Math.max(metadata.width || 0, metadata.height || 0);
    if (currentMax > maxDimension) {
      resizeWidth = maxDimension;
      resizeHeight = maxDimension;
    }
  }

  const inputFormat = metadata.format;
  const hasTransparency = metadata.hasAlpha && !stats.isOpaque;

  const createPipeline = () => {
    let pipeline = sharp(processBuffer).rotate();
    if (resizeWidth && resizeHeight) {
      pipeline = pipeline.resize(resizeWidth, resizeHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    return pipeline;
  };

  let compressedBuffer: Buffer;
  let compressedInfo: { width: number; height: number } | null = null;
  let outputFormat: 'jpeg' | 'png' | 'avif' | 'webp';

  const primaryStart = Date.now();


  const userQuality = apiOptions?.quality;
  const forceFormat = apiOptions?.format;

  if (forceFormat === 'webp') {
    const result_webp_force = await createPipeline()
      .webp({ quality: userQuality ?? 80, effort: 6, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    compressedBuffer = result_webp_force.data;
    compressedInfo = result_webp_force.info;
    outputFormat = 'webp';
  } else if (forceFormat === 'avif') {
    const result_avif_force = await createPipeline()
      .avif({ quality: userQuality ?? 50, effort: 4, chromaSubsampling: '4:2:0' })
      .toBuffer({ resolveWithObject: true });
    compressedBuffer = result_avif_force.data;
    compressedInfo = result_avif_force.info;
    outputFormat = 'avif';
  } else if (forceFormat === 'jpeg') {
    const result_jpeg_force = await createPipeline()
      .jpeg({ quality: userQuality ?? 82, mozjpeg: true, progressive: true })
      .toBuffer({ resolveWithObject: true });
    compressedBuffer = result_jpeg_force.data;
    compressedInfo = result_jpeg_force.info;
    outputFormat = 'jpeg';
  } else if (forceFormat === 'png') {
    const result_png_force = await createPipeline()
      .png({ quality: userQuality ?? 85, compressionLevel: 9, effort: 10 })
      .toBuffer({ resolveWithObject: true });
    compressedBuffer = result_png_force.data;
    compressedInfo = result_png_force.info;
    outputFormat = 'png';
  } else if (inputFormat === 'heif') {
    const result_avif = await createPipeline()
      .avif({
        quality: userQuality ?? 50,
        effort: 4,
        chromaSubsampling: '4:2:0',
      })
      .toBuffer({ resolveWithObject: true });
    compressedBuffer = result_avif.data;
    compressedInfo = result_avif.info;
    outputFormat = 'avif';
  } else if (inputFormat === 'jpeg') {
    const result_jpeg = await createPipeline()
      .jpeg({
        quality: userQuality ?? 82,
        mozjpeg: true,
        progressive: true,
        chromaSubsampling: '4:2:0',
        trellisQuantisation: true,
        overshootDeringing: true,
        optimizeCoding: true,
      })
      .toBuffer({ resolveWithObject: true });
    compressedBuffer = result_jpeg.data;
    compressedInfo = result_jpeg.info;
    outputFormat = 'jpeg';
  } else if (inputFormat === 'webp' || (inputFormat as string) === 'bmp') {
    if (hasTransparency) {
      const result_png_t = await createPipeline()
        .png({
          quality: userQuality ?? 85,
          compressionLevel: 9,
          effort: 10,
        })
        .toBuffer({ resolveWithObject: true });
      compressedBuffer = result_png_t.data;
      compressedInfo = result_png_t.info;
      outputFormat = 'png';
    } else {
      const result_jpeg_t = await createPipeline()
        .jpeg({
          quality: userQuality ?? 82,
          mozjpeg: true,
          progressive: true,
        })
        .toBuffer({ resolveWithObject: true });
      compressedBuffer = result_jpeg_t.data;
      compressedInfo = result_jpeg_t.info;
      outputFormat = 'jpeg';
    }
  } else {
    const result_png_default = await createPipeline()
      .png({
        quality: userQuality ?? 85,
        palette: !hasTransparency,
        colors: 256,
        dither: 1.0,
        compressionLevel: 9,
        effort: 10,
        progressive: true,
      })
      .toBuffer({ resolveWithObject: true });
    compressedBuffer = result_png_default.data;
    compressedInfo = result_png_default.info;
    outputFormat = 'png';
  }

  console.log(JSON.stringify({ event: 'compress_timing', phase: 'primary', format: outputFormat, duration: Date.now() - primaryStart }));

  let alreadyOptimal = false;
  // Preserve requested resizing, format conversion, and browser-compatible HEIC output.
  if (compressedBuffer.length >= originalSize && !wasHeic && !forceFormat && !resizeWidth) {
    compressedBuffer = inputBuffer;
    alreadyOptimal = true;
  }

  // Generate WebP from the input to avoid another lossy encoding step.
  let webpBuffer: Buffer;
  let webpSize: number;

  if (apiOptions) {
    webpBuffer = Buffer.alloc(0);
    webpSize = 0;
  } else {
    const webpStart = Date.now();

    // WebP has a hard pixel limit of 16383x16383. If the image exceeds this,
    // create a resized pipeline for WebP only (primary output stays full resolution).
    const WEBP_MAX_DIMENSION = 16383;
    const webpNeedsResize = (metadata.width || 0) > WEBP_MAX_DIMENSION ||
                             (metadata.height || 0) > WEBP_MAX_DIMENSION;

    if (webpNeedsResize) {
      console.log(JSON.stringify({
        event: 'webp_resize',
        width: metadata.width,
        height: metadata.height,
        maxDimension: WEBP_MAX_DIMENSION,
      }));
    }

    const createWebpPipeline = () => {
      let pipeline = sharp(processBuffer).rotate();
      if (webpNeedsResize) {
        pipeline = pipeline.resize(WEBP_MAX_DIMENSION, WEBP_MAX_DIMENSION, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      } else if (resizeWidth && resizeHeight) {
        pipeline = pipeline.resize(resizeWidth, resizeHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
      return pipeline;
    };

    webpBuffer = await createWebpPipeline()
      .webp({
        quality: 80,
        effort: 6,
        smartSubsample: true,
        ...(hasTransparency ? {} : { alphaQuality: 0 }),
      })
      .toBuffer();
    console.log(JSON.stringify({ event: 'compress_timing', phase: 'webp', duration: Date.now() - webpStart }));
    webpSize = webpBuffer.length;
  }

  const compressedSize = compressedBuffer.length;

  console.log(JSON.stringify({
    event: 'compress_timing',
    phase: 'total',
    duration: Date.now() - startTime,
    inputSize: originalSize,
    outputSize: compressedSize,
    webpSize
  }));

  return {
    buffer: compressedBuffer,
    webpBuffer,
    format: outputFormat,
    originalSize,
    compressedSize,
    webpSize,
    savingsPercent: Math.max(0, Math.round(((originalSize - compressedSize) / originalSize) * 100)),
    webpSavingsPercent: webpSize > 0 ? Math.round(((originalSize - webpSize) / originalSize) * 100) : 0,
    alreadyOptimal,
    width: compressedInfo?.width,
    height: compressedInfo?.height,
  };
}

// Magic bytes validation for security
export function validateMagicBytes(buffer: Buffer): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer.length >= 3 &&
      buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // WebP: RIFF....WEBP
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return 'image/webp';
  }

  // BMP: 42 4D
  if (buffer.length >= 2 &&
      buffer[0] === 0x42 && buffer[1] === 0x4D) {
    return 'image/bmp';
  }

  // AVIF/HEIC: ISOBMFF container with ftyp box
  if (buffer.length >= 12 &&
      buffer[4] === 0x66 && buffer[5] === 0x74 &&
      buffer[6] === 0x79 && buffer[7] === 0x70) {
    const brand = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1') {
      return 'image/avif';
    }
    if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) {
      return 'image/heic';
    }
  }

  return null;
}
