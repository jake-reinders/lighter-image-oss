import type { IncomingMessage, ServerResponse } from 'node:http';

// Hosting adapters supply parsed bodies and response helpers.
export interface VercelRequest extends IncomingMessage {
  body: unknown;
}

export interface VercelResponse extends ServerResponse {
  status(code: number): VercelResponse;
  json(body: unknown): VercelResponse;
}
