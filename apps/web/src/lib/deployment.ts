/** Hosted staging copy for staff testing. Server-only; set DEPLOYMENT_PURPOSE=staging in the staging web project. */
export function isStaging() { return process.env.DEPLOYMENT_PURPOSE === 'staging'; }
