import { expect, it } from 'vitest';
import sharp from 'sharp';
import { compressImage } from '../../gcp/lib/compress.js';

it('preserves AVIF input when resizing', async () => {
    const input = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'red' } }).avif().toBuffer();
    const result = await compressImage(input, { type: 'custom', value: 32, unit: 'px' });
    const metadata = await sharp(result.buffer).metadata();
    expect(result.format).toBe('avif');
    expect(metadata.format).toBe('heif');
    expect(metadata.width).toBe(32);
    expect(metadata.height).toBe(24);
});
