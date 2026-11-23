/**
 * Node adapter.
 *
 * The app itself is a web-standard fetch handler; this module only moves
 * bytes between node:http and Request/Response.
 *
 * Signature verification requires the EXACT raw request bytes, so the
 * adapter buffers the body itself. If other middleware consumed the stream
 * first (e.g. express.json() mounted before this handler), verification
 * would fail on every request — that case is detected and raised as a
 * descriptive error instead.
 *
 * Express mounting:
 *   expressApp.use('/slack', toNodeHandler(app.fetch));
 * Express strips the mount prefix from req.url, so the app's default paths
 * (/events, /install, /oauth_redirect) work at any mount point. Do NOT
 * apply body-parsing middleware to the mount path.
 */

import { createServer } from 'node:http';

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Convert a fetch handler into a node:http request listener.
 *
 * @param {Function} fetchHandler - (Request) => Promise<Response>
 * @returns {(req, res) => void}
 */
export function toNodeHandler(fetchHandler) {
  return async (req, res) => {
    try {
      if (req.readableEnded || req.body !== undefined) {
        throw new Error(
          'Request stream was already consumed before remack saw it. '
          + 'Slack signature verification needs the raw body — remove any '
          + 'body-parsing middleware (express.json/urlencoded) from this route.'
        );
      }

      const rawBody = await readRawBody(req);
      const url = `http://${req.headers.host || 'localhost'}${req.url}`;

      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody,
      });

      const response = await fetchHandler(request);

      res.writeHead(response.status, Object.fromEntries(response.headers));
      const body = Buffer.from(await response.arrayBuffer());
      res.end(body);
    } catch (error) {
      // Never leave Slack hanging — a hung request shows users a ⚠️ timeout
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
      }
      res.end('internal error');
      // eslint-disable-next-line no-console
      console.error('remack adapter error:', error);
    }
  };
}

/**
 * Serve a fetch handler on node:http.
 *
 * @param {Object} options
 * @param {Function} options.fetch - (Request) => Promise<Response>
 * @param {number} [options.port] - Default 3000 (0 picks a free port)
 * @param {string} [options.hostname]
 * @param {AbortSignal} [options.signal] - Abort to close the server
 * @param {Function} [options.onIdle] - Awaited before close resolves
 *   (pass app.idle to drain in-flight continuations on shutdown)
 * @returns {Promise<{server, url, port, close: () => Promise<void>}>}
 */
export function serve({ fetch: fetchHandler, port = 3000, hostname, signal, onIdle }) {
  const server = createServer(toNodeHandler(fetchHandler));

  async function close() {
    if (typeof onIdle === 'function') {
      await onIdle();
    }
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  if (signal) {
    signal.addEventListener('abort', () => { close().catch(() => {}); }, { once: true });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      const address = server.address();
      const host = hostname || 'localhost';
      resolve({
        server,
        port: address.port,
        url: `http://${host}:${address.port}`,
        close,
      });
    });
  });
}
