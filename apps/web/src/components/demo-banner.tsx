export function DemoBanner() {
  if (process.env.DEPLOYMENT_PURPOSE !== 'demo') return null;
  return <div role="note" className="border-b border-amber-400 bg-amber-100 px-5 py-3 text-center text-sm font-semibold text-amber-950">Demo Environment — Fictional Data Only</div>;
}
