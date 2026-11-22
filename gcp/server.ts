import express from 'express';
import { signedUrlRouter } from './routes/signed-url.js';
import { compressRouter } from './routes/compress.js';
import { cleanupRouter } from './routes/cleanup.js';
import { healthRouter } from './routes/health.js';
import { validateUploadConfig } from './lib/upload-grant.js';

const app = express();
const PORT = process.env.PORT || 8080;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://example.com,http://localhost:3000').split(',');

app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '3600');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: Date.now() - start,
      timestamp: new Date().toISOString(),
    }));
  });
  next();
});

app.use('/health', healthRouter);
app.use('/signed-url', signedUrlRouter);
app.use('/compress', compressRouter);
app.use('/cleanup', cleanupRouter);

function main() {
  validateUploadConfig();
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(JSON.stringify({
      event: 'request_error',
      timestamp: new Date().toISOString(),
    }));
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(JSON.stringify({
      event: 'server_start',
      port: PORT,
      env: process.env.NODE_ENV,
      timestamp: new Date().toISOString(),
    }));
  });
}

main();
