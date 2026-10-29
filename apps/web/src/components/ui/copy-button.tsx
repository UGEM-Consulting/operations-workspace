'use client';
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './button';

/** Copies a value to the clipboard and confirms in place. `label` names what is copied for screen readers. */
export function CopyButton({ text, label, copiedLabel = 'Copied', size, variant = 'outline' }: { text: string; label: string; copiedLabel?: string; size?: 'sm' | 'default'; variant?: 'outline' | 'ghost' }) {
  const [copied, setCopied] = useState(false);
  return <Button type="button" variant={variant} size={size} onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); } }}>
    {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}{copied ? copiedLabel : label}
    <span className="sr-only" role="status">{copied ? `${label}: copied` : ''}</span>
  </Button>;
}
