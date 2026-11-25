// The website uses the remote API both in production and from a local server.
// Loopback origins still require normal authenticated sessions for private data.
export function allowedBrowserOrigin(origin) {
  if (!origin) return true; // Non-browser requests remain subject to authentication.
  if (['https://andrewzc.net', 'https://api.andrewzc.net'].includes(origin)) return true;
  if (typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && ['http:', 'https:'].includes(url.protocol)
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

// Shared by every browser-facing route, including admin and timeline.
export const browserCorsOptions = {
  origin(origin, callback) {
    if (allowedBrowserOrigin(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
};
