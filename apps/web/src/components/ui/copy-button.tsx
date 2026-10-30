'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './button';

/**
 * Copies a value to the clipboard and confirms in place. `label` names what is copied for screen readers. The status
 * message sits next to the button, not inside it, so it never becomes part of the button's name.
 */
export function CopyButton({ text, label, copiedLabel = 'Copied', size, variant = 'outline' }: { text: string; label: string; copiedLabel?: string; size?: 'sm' | 'default'; variant?: 'outline' | 'ghost' }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    try { await navigator.clipboard.writeText(text); setCopied(true); timer.current = setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  }
  return <>
    <Button type="button" variant={variant} size={size} onClick={() => void copy()}>
      {copied ? <Check aria-hidden="true" className="size-4" /> : <Copy aria-hidden="true" className="size-4" />}{copied ? copiedLabel : label}
    </Button>
    <span className="sr-only" role="status">{copied ? `${label}: copied` : ''}</span>
  </>;
}
