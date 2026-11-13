/** Short names fit beside the verb on a phone's full-width button ("Sign NDA", "Sign SOP"). */
const FITS = 16;

/**
 * The signing window's final button (SignSignatureScreen, AckSignPhoneScreen): the verb with a short document name, or
 * the verb alone for a long one, so the button never runs past a phone screen. Screen readers always get the full name.
 */
export function signButtonLabel(short: string, requiresSignature: boolean): { text: string; label: string } {
  const verb = requiresSignature ? 'Sign' : 'Confirm';
  return { text: short.length <= FITS ? `${verb} ${short}` : verb, label: `${verb} ${short}` };
}
