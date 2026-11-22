import type { VercelRequest, VercelResponse } from '../../lib/http.js';
import { callCloudRun } from '../../lib/gcp-auth.js';

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 10;

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function getClientIP(req: VercelRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
    return ips.trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (rateLimitMap.size > 10000) {
    for (const [key, val] of rateLimitMap.entries()) {
      if (now > val.resetTime) {
        rateLimitMap.delete(key);
      }
    }
  }

  if (!entry || now > entry.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - 1, resetIn: RATE_LIMIT_WINDOW_MS };
  }

  if (entry.count >= RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetIn: entry.resetTime - now };
  }

  entry.count++;
  return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS - entry.count, resetIn: entry.resetTime - now };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  const startTime = Date.now();

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const clientIP = getClientIP(req);
  const rateLimit = checkRateLimit(clientIP);

  res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX_REQUESTS);
  res.setHeader('X-RateLimit-Remaining', rateLimit.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(rateLimit.resetIn / 1000));

  if (!rateLimit.allowed) {
    console.log(JSON.stringify({
      event: 'rate_limit_exceeded',
      ip: clientIP.substring(0, 8) + '***',
      timestamp: new Date().toISOString(),
    }));
    return res.status(429).json({
      success: false,
      error: 'Too many requests. Please try again later.',
      retryAfter: Math.ceil(rateLimit.resetIn / 1000),
    });
  }

  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, error: 'Expected a JSON object' });
    }
    const { uploadToken, outputFormat, resize } = req.body as Record<string, unknown>;

    if (typeof uploadToken !== 'string' || !uploadToken || uploadToken.length > 4096) {
      return res.status(403).json({
        success: false,
        error: 'A valid upload token is required',
      });
    }

    const response = await callCloudRun('/compress', {
      body: {
        uploadToken,
        outputFormat,
        resize,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const duration = Date.now() - startTime;

    console.log(JSON.stringify({
      event: 'gcp_compression_complete',
      inputSize: data.originalSize,
      outputSize: data.compressedSize,
      webpSize: data.webpSize,
      duration,
      timestamp: new Date().toISOString(),
    }));

    return res.status(200).json(data);
  } catch (error) {
    console.error('Compression proxy request failed');
    return res.status(500).json({ success: false, error: 'Compression service unavailable' });
  }
}
