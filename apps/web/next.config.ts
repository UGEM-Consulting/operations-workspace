import type { NextConfig } from "next";

// A partial Content-Security-Policy: it blocks framing, plugins, <base> hijacking and off-site form posts.
// script-src/style-src are deliberately not restricted: Next.js inlines bootstrap scripts, and a strict
// script policy needs per-request nonces from a proxy, which would also make every page dynamic per nonce.
const contentSecurityPolicy = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join('; ');
const securityHeaders = [
  { key: 'Content-Security-Policy', value: contentSecurityPolicy },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // The applicant selfie capture needs the camera on this origin only.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  // HTTPS-only deployments (production and staging); never sent by the local development server.
  ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
];

const config: NextConfig = {
 poweredByHeader: false,
 // Development request logs stay off: applicant paths and query strings are not written to the terminal.
 logging: { incomingRequests: false },
 async headers() { return [
  { source: '/:path*', headers: securityHeaders },
  // Applicant pages: no Referer at all (overrides the default above), never cached, never indexed.
  { source: '/apply/:path*', headers: [
   { key: 'Referrer-Policy', value: 'no-referrer' },
   { key: 'Cache-Control', value: 'no-store, private' },
   { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  ] },
  // Driver application pages: the same rules (the link token lives in the fragment; answers include an SSN).
  { source: '/driver/:path*', headers: [
   { key: 'Referrer-Policy', value: 'no-referrer' },
   { key: 'Cache-Control', value: 'no-store, private' },
   { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  ] },
 ]; },
};
export default config;
