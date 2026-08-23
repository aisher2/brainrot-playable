/* ============================================================
   index.js - Cloudflare Worker entry.

   Static files come from the built dist/ via the ASSETS binding;
   everything the relay owns (/ws, /api, /health) is forwarded to a
   single Durable Object so all players share one queue.
   ============================================================ */

export { Relay } from './relay.js';

const RELAY_PATHS = new Set(['/ws', '/api/top', '/api/score', '/health']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (RELAY_PATHS.has(url.pathname)) {
      // One instance for the whole game: matchmaking only works if every
      // waiting player is visible to the same object.
      const id = env.RELAY.idFromName('global');
      return env.RELAY.get(id).fetch(request);
    }

    // CORS preflight for a game served from another origin (GitHub Pages).
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
