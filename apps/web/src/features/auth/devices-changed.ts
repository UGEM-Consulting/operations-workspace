/**
 * Sent on Account security when something forgets every device without a reload (a password change), so the trusted devices
 * card loads again. The other changes there that forget them (a new authenticator, turning two-step verification on or off)
 * load the page afresh. Its own module, so the sign-in's password step doesn't load the devices card.
 */
export const DEVICES_CHANGED_EVENT = 'account-security:devices-changed';
