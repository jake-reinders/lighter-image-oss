import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { validateMagicBytes } from '../../lib/compress.js';
import { compressImage } from '../../lib/compress.js';

describe('Image compression', () => {
  it('rejects non-image file via validateMagicBytes', () => {
    const textBuf = Buffer.from('Hello, world! This is not an image.');
    expect(validateMagicBytes(textBuf)).toBeNull();
  });

  it('accepts JPEG via validateMagicBytes', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
    expect(validateMagicBytes(jpeg)).toBe('image/jpeg');
  });

  it('accepts PNG via validateMagicBytes', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: 'blue' } }).png().toBuffer();
    expect(validateMagicBytes(png)).toBe('image/png');
  });

  it('compresses JPEG successfully with quality option', async () => {
    const jpeg = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const result = await compressImage(jpeg, undefined, { quality: 50 });
    expect(result.buffer).toBeDefined();
    expect(result.compressedSize).toBeGreaterThan(0);
    expect(result.format).toBe('jpeg');
    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
  });

  it('compresses with format override to webp', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'green' } }).jpeg().toBuffer();
    const result = await compressImage(jpeg, undefined, { format: 'webp' });
    expect(result.format).toBe('webp');
  });

  it('returns correct response shape', async () => {
    const jpeg = await sharp({ create: { width: 50, height: 50, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const result = await compressImage(jpeg);
    expect(result).toMatchObject({
      buffer: expect.any(Buffer),
      webpBuffer: expect.any(Buffer),
      originalSize: expect.any(Number),
      compressedSize: expect.any(Number),
      savingsPercent: expect.any(Number),
      format: expect.any(String),
      width: expect.any(Number),
      height: expect.any(Number),
    });
  });

  it('does not revert to original format when format override is set and output is larger', async () => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: 'red' } }).png({ compressionLevel: 9 }).toBuffer();
    const result = await compressImage(png, undefined, { format: 'avif' });
    expect(result.format).toBe('avif');
    expect(result.alreadyOptimal).toBe(false);
  });

});
