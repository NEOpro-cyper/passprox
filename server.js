/**
 * HLS / m3u8 CORS proxy — Cloudflare Worker port for VPS.
 * Zero dependencies. Requires Node.js 18+ (built-in fetch).
 *
 * Usage:   http://YOUR_VPS_IP:3000/https://target.com/path/stream.m3u8
 * Env:     PORT (default 3000) | HOST (default 0.0.0.0) | PROXY_TOKEN (optional)
 *
 * PROXY_TOKEN (optional shared secret): if set, clients must append ?_key=<token>
 * to the proxied URL or send an "x-proxy-token" header. Off by default.
 */

'use strict';

const http = require('http');
const { Readable } = require('stream');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PROXY_TOKEN = process.env.PROXY_TOKEN || '';

/* ------------------------------------------------------------------ */
/* Headers sent upstream — mirrors exactly what the Worker spoofed     */
/* ------------------------------------------------------------------ */
function buildUpstreamHeaders(req) {
  const h = {
    'Referer': 'https://play.xpass.top/',
    'Origin': 'https://play.xpass.top',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  };

  // Small extras the Worker/CF runtime handled implicitly:
  if (req.headers.range) h['Range'] = req.headers.range;            // video seeking
  if (req.headers.cookie) h['Cookie'] = req.headers.cookie;         // cookies if player sent any
  if (req.headers['content-type']) h['Content-Type'] = req.headers['content-type']; // POST/PUT bodies
  return h;
}

/* ------------------------------------------------------------------ */
/* CORS headers added to every response (same as the Worker)           */
/* ------------------------------------------------------------------ */
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': '*'
};

/* Hop-by-hop / recomputed headers we must NOT copy from upstream.
 * content-encoding: fetch() already decompressed the body.            */
const SKIPPED = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'content-encoding'
]);

/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // stop upstream when client leaves

  try {
    /* ---- Health check for Docker/Coolify/K8s probes ---- */
    if (req.url === '/health' || req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain', ...CORS });
      return res.end('ok');
    }

    /* ---- CORS preflight (same as Worker's OPTIONS branch) ---- */
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }

    /* ---- Our own origin, used to rewrite playlist URLs ----
     * Honors X-Forwarded-Proto so it works behind nginx/caddy with TLS. */
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
    const selfOrigin = `${proto}://${req.headers.host || `localhost:${PORT}`}`;

    /* ---- Extract target URL from the RAW request path ----
     * Tolerates URL rewriting by proxies sitting in front of this app
     * (nginx merge_slashes, some CDNs / Traefik normalizations):
     *   /https://host/path          normal
     *   /https:/host/path           // merged into / (nginx merge_slashes, default ON)
     *   //https://host/path         extra leading slashes
     *   /https%3A%2F%2Fhost/path    percent-encoded by an intermediary
     */
    let rawTarget = req.url || '/';

    // Absolute-form request line (some intermediaries send these)
    rawTarget = rawTarget.replace(/^https?:\/\/[^/]+/i, '');

    const qIdx = rawTarget.indexOf('?');
    const rawPathPart = qIdx === -1 ? rawTarget : rawTarget.slice(0, qIdx);
    const rawSearch = qIdx === -1 ? '' : rawTarget.slice(qIdx);
    const candidate = rawPathPart.replace(/^\/+/, '');            // strip leading slashes
    const fixScheme = (s) => s.replace(/^(https?:)\/+/i, '$1//'); // https:/x → https://x

    let targetUrl = null;
    const direct = fixScheme(candidate);
    if (/^https?:\/\//i.test(direct)) {
      try { targetUrl = new URL(direct + rawSearch); } catch { /* fall through */ }
    }
    if (!targetUrl) {
      // Fallback: an intermediary may have percent-encoded the target URL
      try {
        let decoded = candidate;
        for (let i = 0; i < 2 && !/^https?:\/\//i.test(decoded); i++) {
          decoded = decodeURIComponent(decoded);
        }
        decoded = fixScheme(decoded);
        if (/^https?:\/\//i.test(decoded)) targetUrl = new URL(decoded + rawSearch);
      } catch { /* fall through */ }
    }

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain', ...CORS });
      return res.end('Invalid proxy usage. Format: ' + selfOrigin + '/https://target.com/path'
        + '\nReceived path: ' + rawTarget.slice(0, 300));
    }

    /* ---- Optional shared-secret gate ---- */
    if (PROXY_TOKEN) {
      const given = new URLSearchParams(rawSearch).get('_key') || req.headers['x-proxy-token'];
      if (given !== PROXY_TOKEN) {
        res.writeHead(403, { 'Content-Type': 'text/plain', ...CORS });
        return res.end('Forbidden: missing or invalid token.');
      }
      targetUrl.searchParams.delete('_key'); // don't leak the token upstream
    }

    /* ---- Read request body (buffered; this proxy is mostly GETs) ---- */
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }

    /* ---- Fetch from the origin with the spoofed headers ---- */
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: buildUpstreamHeaders(req),
      body,
      redirect: 'follow',
      signal: abort.signal
    });

    const contentType = upstream.headers.get('content-type') || '';
    const isPlaylist = contentType.includes('mpegurl') || targetUrl.pathname.endsWith('.m3u8');
    // Resolve relative playlist lines against the FINAL url (after redirects)
    const baseUrl = upstream.url || targetUrl.toString();

    /* ---- Copy upstream response headers, fixing body-related ones ---- */
    const outHeaders = {};
    upstream.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (SKIPPED.has(k)) return;
      // m3u8 text gets rewritten; compressed bodies arrive decoded → length changes
      if (k === 'content-length' && (isPlaylist || upstream.headers.has('content-encoding'))) return;
      outHeaders[key] = value;
    });

    if (isPlaylist) {
      /* ---- Rewrite the playlist so every URI goes back through us ---- */
      let text = await upstream.text();

      // 1) Absolute URLs → route through the proxy
      text = text.replace(/(https?:\/\/[^\s<>"']+)/g, (match) => {
        if (match.startsWith(selfOrigin)) return match; // already proxied
        return `${selfOrigin}/${match}`;
      });

      // 2) Relative URLs (lines that aren't tags and aren't absolute)
      text = text.split('\n').map((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('http')) {
          const absolute = new URL(trimmed, baseUrl).toString();
          return absolute.startsWith(selfOrigin) ? absolute : `${selfOrigin}/${absolute}`;
        }
        return line;
      }).join('\n');

      outHeaders['Content-Type'] = 'application/vnd.apple.mpegurl';
      const body = Buffer.from(text, 'utf8');
      if (upstream.status !== 204 && upstream.status !== 304) {
        outHeaders['Content-Length'] = String(body.length);
      }
      res.writeHead(upstream.status, outHeaders);
      return res.end(body);
    }

    /* ---- Everything else (segments, keys, images...) streams as-is ---- */
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      Readable.fromWeb(upstream.body)
        .on('error', () => res.destroy())
        .pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (abort.signal.aborted || res.destroyed) return res.destroy(); // client went away
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain', ...CORS });
      res.end('Error: ' + (err && err.message ? err.message : String(err)));
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[hls-proxy] listening on http://${HOST}:${PORT}`);
  console.log(`[hls-proxy] usage: http://<your-vps-ip>:${PORT}/https://target.com/stream.m3u8`);
});

/* Graceful shutdown (pm2 / systemd friendly) */
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
