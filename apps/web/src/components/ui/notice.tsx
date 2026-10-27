import { CheckCircle2, CircleAlert } from 'lucide-react';
export function Notice({ message, error = false }: { message: string; error?: boolean }) {
  if (!message) return null;
  const Icon = error ? CircleAlert : CheckCircle2;
  return <div role={error ? 'alert' : 'status'} className={`flex items-start gap-2 rounded-xl border p-4 text-sm ${error ? 'border-danger-border bg-danger-background text-danger' : 'border-success-border bg-success-background text-success'}`}><Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" /><p className="min-w-0 break-words">{message}</p></div>;
}
