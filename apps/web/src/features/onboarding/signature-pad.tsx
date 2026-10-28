'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
const WIDTH = 600, HEIGHT = 180;
// Installed handwriting-style fonts; no web font is downloaded. The image is what is signed, not the font.
const SCRIPT_FONT = '"Segoe Script", "Brush Script MT", "Lucida Handwriting", "Snell Roundhand", "Apple Chancery", cursive';
export type SignatureMethod = 'DRAWN' | 'TYPED';
/**
 * Sign with mouse, pen or finger, or (with allowTyped) adopt the typed name rendered in a script font onto the same
 * canvas. Either way it reports a transparent PNG data URL and how it was made, or null when cleared.
 */
export function SignaturePad({ label, onChange, disabled = false, allowTyped = false, typedName = '', touch = false }: {
 label: string; onChange: (dataUrl: string | null, method: SignatureMethod) => void; disabled?: boolean;
 allowTyped?: boolean; typedName?: string; touch?: boolean;
}) {
 const canvas = useRef<HTMLCanvasElement>(null), drawing = useRef(false), adopted = useRef('');
 const [mode, setMode] = useState<SignatureMethod>('DRAWN'), [status, setStatus] = useState(''), [filled, setFilled] = useState(false);
 const id = useId(), size = touch ? 'lg' : 'default';
 const context = () => canvas.current?.getContext('2d') ?? null;
 function reset(message: string) {
  context()?.clearRect(0, 0, WIDTH, HEIGHT); adopted.current = ''; setFilled(false);
  onChange(null, mode); setStatus(message);
 }
 // An adopted signature must match the name being signed; a changed name needs a new adoption.
 useEffect(() => {
  if (mode !== 'TYPED' || !adopted.current || adopted.current === typedName.trim()) return;
  canvas.current?.getContext('2d')?.clearRect(0, 0, WIDTH, HEIGHT); adopted.current = '';
  setFilled(false); onChange(null, 'TYPED'); setStatus('Your typed name changed. Adopt the typed signature again.');
 }, [typedName, mode, onChange]);
 function point(event: React.PointerEvent<HTMLCanvasElement>) {
  const box = event.currentTarget.getBoundingClientRect();
  return [(event.clientX - box.left) * WIDTH / box.width, (event.clientY - box.top) * HEIGHT / box.height] as const;
 }
 function start(event: React.PointerEvent<HTMLCanvasElement>) {
  if (disabled || mode !== 'DRAWN') return;
  event.currentTarget.setPointerCapture(event.pointerId);
  const ctx = event.currentTarget.getContext('2d')!, [x, y] = point(event);
  ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#111827';
  drawing.current = true; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 0.1, y + 0.1); ctx.stroke();
 }
 function move(event: React.PointerEvent<HTMLCanvasElement>) {
  if (!drawing.current) return;
  const ctx = event.currentTarget.getContext('2d')!, [x, y] = point(event);
  ctx.lineTo(x, y); ctx.stroke();
 }
 function end(event: React.PointerEvent<HTMLCanvasElement>) {
  if (!drawing.current) return;
  drawing.current = false;
  onChange(event.currentTarget.toDataURL('image/png'), 'DRAWN');
  if (!filled) { setFilled(true); setStatus('Signature added.'); }
 }
 function adopt() {
  const ctx = context(), name = typedName.trim();
  if (!ctx) return;
  if (!/^[A-Za-z][A-Za-z .,'-]+$/.test(name)) { setStatus('Type your full legal name in Latin letters first.'); return; }
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  let fontSize = 72;
  do { ctx.font = `${fontSize}px ${SCRIPT_FONT}`; fontSize -= 4; } while (ctx.measureText(name).width > WIDTH - 48 && fontSize > 20);
  ctx.fillStyle = '#111827'; ctx.textBaseline = 'middle'; ctx.fillText(name, 24, HEIGHT / 2);
  adopted.current = name; setFilled(true);
  onChange(canvas.current!.toDataURL('image/png'), 'TYPED'); setStatus('Typed signature adopted.');
 }
 function switchMode(next: SignatureMethod) {
  if (next === mode) return;
  context()?.clearRect(0, 0, WIDTH, HEIGHT); adopted.current = ''; setFilled(false); setMode(next);
  onChange(null, next); setStatus(next === 'TYPED' ? 'Typed signature selected.' : 'Drawn signature selected.');
 }
 const instructions = mode === 'DRAWN'
  ? `Draw your signature in the box with your mouse, pen or finger.${allowTyped ? ' To sign with the keyboard instead, choose Type signature.' : ''}`
  : 'Your typed full legal name is shown in a handwriting style. Choose Adopt typed signature to use it as your signature.';
 return <div role="group" aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`} className="space-y-2">
  <p id={`${id}-label`} className="text-sm font-medium">{label}</p>
  {allowTyped && <div className="flex flex-wrap gap-2">
   <Button type="button" size={size} variant={mode === 'DRAWN' ? 'secondary' : 'outline'} aria-pressed={mode === 'DRAWN'} disabled={disabled} onClick={() => switchMode('DRAWN')}>Draw signature</Button>
   <Button type="button" size={size} variant={mode === 'TYPED' ? 'secondary' : 'outline'} aria-pressed={mode === 'TYPED'} disabled={disabled} onClick={() => switchMode('TYPED')}>Type signature</Button>
  </div>}
  <p id={`${id}-help`} className="text-[13px] leading-5 text-muted-foreground">{instructions}</p>
  <canvas ref={canvas} width={WIDTH} height={HEIGHT} role="img" aria-labelledby={`${id}-label`} aria-describedby={`${id}-state`}
   onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
   className={`aspect-[10/3] w-full touch-none rounded-md border border-dashed border-input bg-white ${disabled ? 'opacity-60' : mode === 'DRAWN' ? 'cursor-crosshair' : ''}`}/>
  <p id={`${id}-state`} className="sr-only">{filled ? 'A signature is in the box.' : 'The signature box is empty.'}</p>
  <div className="flex flex-wrap items-center justify-between gap-3">
   <p role="status" aria-live="polite" className="text-[13px] leading-5 text-muted-foreground">{status}</p>
   <div className="flex flex-wrap gap-2">
    {mode === 'TYPED' && <Button type="button" size={size} disabled={disabled} onClick={adopt}>Adopt typed signature</Button>}
    <Button type="button" size={size} variant="outline" disabled={disabled || !filled} onClick={() => reset('Signature cleared.')}>Clear signature</Button>
   </div>
  </div>
 </div>;
}
