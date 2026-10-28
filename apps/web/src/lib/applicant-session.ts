// The API ends an applicant session one hour after verification (not sliding). The browser records when it verified
// so the form can show the remaining time. Only this timestamp is stored, never a token, code or reference.
export const APPLICANT_SESSION_MS = 60 * 60 * 1000;
const key = 'applicant-session-expires';
let expiresAt: number | null = null;

export function markApplicantVerified(now: number = Date.now()) {
  expiresAt = now + APPLICANT_SESSION_MS;
  try { window.sessionStorage.setItem(key, String(expiresAt)); } catch { /* storage unavailable: memory only */ }
}
export function clearApplicantSession() {
  expiresAt = null;
  try { window.sessionStorage.removeItem(key); } catch { /* ignore */ }
}
/** The expiry when this tab verified, or null when unknown (for example after verifying in another tab). */
export function applicantSessionExpiry(): number | null {
  if (expiresAt) return expiresAt;
  try {
    const stored = Number(window.sessionStorage.getItem(key));
    if (Number.isFinite(stored) && stored > 0) expiresAt = stored;
  } catch { /* ignore */ }
  return expiresAt;
}
