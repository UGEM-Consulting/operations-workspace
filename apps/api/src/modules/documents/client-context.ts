import { isIP } from 'node:net';
import type { Request } from 'express';
export interface ClientContext {ipAddress:string|null;userAgent:string|null;}
/**
 * Signer IP address and browser for signature evidence. The same-origin BFF forwards them from the browser request;
 * every API request already requires the server-only BFF secret, so these headers cannot come from a browser directly.
 */
export function clientContext(req: Request): ClientContext {
 const ip = String(req.headers['x-client-ip'] ?? '').trim(), agent = String(req.headers['x-client-user-agent'] ?? '').trim();
 return { ipAddress: isIP(ip) ? ip : null, userAgent: agent ? agent.slice(0,500) : null };
}
