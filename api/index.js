/**
 * Vercel Serverless Adapter
 *
 * Imports the compiled Fastify app and wraps it as a Vercel serverless function handler.
 * server.ts exports `app` (the Fastify instance); we use app.server to handle raw Node.js requests.
 */
import { app } from '../dist/server.js';

// Ensure Fastify is ready before handling requests
let isReady = false;
async function ensureReady() {
  if (!isReady) {
    await app.ready();
    isReady = true;
  }
}

export default async function handler(req, res) {
  await ensureReady();
  app.server.emit('request', req, res);
}
