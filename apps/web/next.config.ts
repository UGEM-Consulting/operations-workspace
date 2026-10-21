import type { NextConfig } from "next";
const config: NextConfig = {
 poweredByHeader: false,
 // Invitation URLs are credentials: disable Next development request URL logging.
 logging: { incomingRequests: false },
 async headers() { return [{ source: '/apply/:path*', headers: [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cache-Control', value: 'no-store, private' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
 ] }]; },
};
export default config;
