/**
 * Vercel Serverless Gateway & Dashboard Adapter
 *
 * Directs API requests directly to the 24/7 Render backend (https://mittal-palms-voice-agent.onrender.com)
 * while serving the web dashboard for browser requests.
 */
import { Readable } from 'stream';
import { app } from '../dist/server.js';

let isReady = false;
async function ensureReady() {
  if (!isReady) {
    await app.ready();
    isReady = true;
  }
}

const BACKEND_ORIGIN = process.env.RENDER_BACKEND_URL || 'https://mittal-palms-voice-agent.onrender.com';

export default async function handler(req, res) {
  const url = req.url || '';

  // 1. Proxy API and data routes to the persistent 24/7 Render backend container
  if (
    url.startsWith('/api/') ||
    url.startsWith('/health') ||
    url.startsWith('/admin/export') ||
    url.startsWith('/audio/')
  ) {
    const targetUrl = `${BACKEND_ORIGIN}${url}`;
    try {
      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];

      const fetchOptions = {
        method: req.method,
        headers,
      };

      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        let bodyBuffer = [];
        if (req.body) {
          fetchOptions.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
          if (!headers['content-type']) {
            headers['content-type'] = 'application/json';
          }
        } else {
          // If body is in a stream
          await new Promise((resolve) => {
            req.on('data', (chunk) => bodyBuffer.push(chunk));
            req.on('end', () => {
              if (bodyBuffer.length > 0) {
                fetchOptions.body = Buffer.concat(bodyBuffer);
              }
              resolve();
            });
          });
        }
      }

      const proxyRes = await fetch(targetUrl, fetchOptions);
      res.statusCode = proxyRes.status;

      proxyRes.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(lower)) {
          res.setHeader(key, val);
        }
      });

      // Handle Server-Sent Events (SSE) streaming for real-time live feed
      const contentType = proxyRes.headers.get('content-type') || '';
      if (contentType.includes('text/event-stream') && proxyRes.body) {
        const stream = Readable.fromWeb(proxyRes.body);
        stream.pipe(res);
        req.on('close', () => {
          stream.destroy();
        });
        return;
      }

      const responseBuffer = await proxyRes.arrayBuffer();
      res.end(Buffer.from(responseBuffer));
      return;
    } catch (err) {
      console.error('[Vercel Gateway] Proxy error:', err);
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Gateway Connection Error', message: err.message }));
      return;
    }
  }

  // 2. Serve Web Dashboard UI
  await ensureReady();
  app.server.emit('request', req, res);
}
