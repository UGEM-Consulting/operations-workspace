import { NextRequest, NextResponse } from 'next/server';
import { backendConfig } from '@/lib/auth';
import { allowedEndpoint, validMutation } from '@/lib/bff-policy';
export const runtime = 'nodejs';
async function proxy(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join('/');
  if (!allowedEndpoint(req.method, path)) return NextResponse.json({ message: 'Not found' }, { status: 404 });
  try {
    const { base, key, origin } = backendConfig();
    const mutating = !['GET', 'HEAD'].includes(req.method);
    if (mutating && !validMutation(req.headers, origin)) return NextResponse.json({ message: 'Invalid request origin or CSRF protection' }, { status: 403 });
    const body = mutating ? await req.text() : undefined;
    if (body && Buffer.byteLength(body) > 16384) return NextResponse.json({ message: 'Request too large' }, { status: 413 });
    const suffix = path.startsWith('applicant/') ? 'applicant.sid' : 'operations.sid';
    const name = process.env.NODE_ENV === 'production' ? `__Host-${suffix}` : suffix;
    const cookie = req.cookies.get(name);
    const query = new URLSearchParams();
    if (path === 'onboarding/review-queue' || path === 'it/onboarding') {
      for (const name of ['page','pageSize','status','search','sort','direction']) {
        const value = req.nextUrl.searchParams.get(name);
        if (value !== null) query.set(name,value);
      }
    }
    const upstream = await fetch(`${base}/api/${path}${query.size ? `?${query}` : ''}`, { method: req.method, body,
      headers: { 'content-type': 'application/json', 'x-workspace-key': key, origin,
        'x-csrf-protection': '1', 'x-forwarded-proto': process.env.NODE_ENV === 'production' ? 'https' : 'http',
        cookie: cookie ? `${name}=${cookie.value}` : '' }, cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const response = new NextResponse(upstream.status === 204 ? null : await upstream.text(), {
      status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    for (const value of upstream.headers.getSetCookie()) response.headers.append('set-cookie', value);
    return response;
  } catch { return NextResponse.json({ message: 'The service is unavailable. Please try again.' }, { status: 503 }); }
}
export { proxy as GET, proxy as POST, proxy as PATCH };
