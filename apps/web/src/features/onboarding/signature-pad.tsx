'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
const WIDTH = 600, HEIGHT = 300;
export const LATIN_NAME = /^[A-Za-z][A-Za-z .,'-]+$/;
const NAME_FIRST = 'Type your full legal name in Latin letters first.', ADOPT_AGAIN = 'Your typed name changed. Adopt the typed signature again.';
// Installed handwriting-style fonts; no web font is downloaded. The image is what is signed, not the font.
const SCRIPT_FONT = '"Segoe Script", "Brush Script MT", "Lucida Handwriting", "Snell Roundhand", "Apple Chancery", cursive';
export type SignatureMethod = 'DRAWN' | 'TYPED';
/** The drawing cropped to its edges, so it fills a signature line on a form instead of sitting in empty space. */
function cropped(canvas: HTMLCanvasElement): string {
 const ctx = canvas.getContext('2d')!, { data } = ctx.getImageData(0, 0, WIDTH, HEIGHT);
 let left = WIDTH, right = -1, top = HEIGHT, bottom = -1;
 for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) if (data[(y * WIDTH + x) * 4 + 3] > 8) { if (x < left) left = x; if (x > right) right = x; if (y < top) top = y; if (y > bottom) bottom = y; }
 if (right < 0) return canvas.toDataURL('image/png');
 const pad = 4, x = Math.max(left - pad, 0), y = Math.max(top - pad, 0), width = Math.min(right + pad, WIDTH - 1) - x + 1, height = Math.min(bottom + pad, HEIGHT - 1) - y + 1;
 const out = document.createElement('canvas'); out.width = width; out.height = height;
 out.getContext('2d')!.drawImage(canvas, x, y, width, height, 0, 0, width, height);
 return out.toDataURL('image/png');
}
/** The name in a script font, shrunk to fit the box. */
function paintName(ctx: CanvasRenderingContext2D, name: string, color: string) {
 let fontSize = 72;
 do { ctx.font = `${fontSize}px ${SCRIPT_FONT}`; fontSize -= 4; } while (ctx.measureText(name).width > WIDTH - 48 && fontSize > 20);
 ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(name, 24, HEIGHT / 2);
}
/** A signature already made, at the size it was drawn in the pad: the image is cropped, so filling the frame would enlarge it. */
export function SignatureShown({ image, alt, onChange }: { image: string; alt: string; onChange?: () => void }) {
 const [width, setWidth] = useState(0);
 return <div className="relative grid aspect-[2/1] w-full max-w-[440px] place-items-center rounded-md border border-input bg-white short:max-w-[240px]">
  {/* eslint-disable-next-line @next/next/no-img-element -- a data URL the signer made */}
  <img src={image} alt={alt} onLoad={event => setWidth(event.currentTarget.naturalWidth)} className={width ? 'h-auto' : 'invisible'} style={{ width: `${width / WIDTH * 100}%` }} />
  {onChange && <Button type="button" size="sm" variant="outline" className="absolute right-2 top-2 bg-card" onClick={onChange}>Change<span className="sr-only"> signature</span></Button>}
 </div>;
}
/**
 * Sign with mouse, pen or finger, or (with allowTyped) adopt the typed name rendered in a script font onto the same
 * canvas. Either way it reports a transparent PNG data URL and how it was made, or null when cleared.
 */
export function SignaturePad({ label, onChange, disabled = false, allowTyped = false, typedName = '', compact = false }: {
 label: string; onChange: (dataUrl: string | null, method: SignatureMethod) => void; disabled?: boolean;
 allowTyped?: boolean; typedName?: string; /** Small screens: fewer words, and Clear sits inside the box, so everything fits together. */ compact?: boolean;
}) {
 const canvas = useRef<HTMLCanvasElement>(null), drawing = useRef(false), adopted = useRef('');
 const [mode, setMode] = useState<SignatureMethod>('DRAWN'), [status, setStatus] = useState(''), [filled, setFilled] = useState(false);
 const id = useId();
 const context = () => canvas.current?.getContext('2d') ?? null;
 function reset(message: string) {
  context()?.clearRect(0, 0, WIDTH, HEIGHT); adopted.current = ''; setFilled(false);
  onChange(null, mode); setStatus(message);
 }
 // An adopted signature must match the name being signed; a changed name needs a new adoption. Until one is adopted the
 // box previews the name in grey: nothing counts as signed, and only Adopt reports an image.
 useEffect(() => {
  const ctx = canvas.current?.getContext('2d'), name = typedName.trim();
  if (mode !== 'TYPED' || !ctx || (adopted.current && adopted.current === name)) return;
  if (adopted.current) { adopted.current = ''; setFilled(false); onChange(null, 'TYPED'); setStatus(ADOPT_AGAIN); }
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  if (LATIN_NAME.test(name)) paintName(ctx, name, '#6b7280');
 }, [typedName, mode, filled, onChange]);
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
  onChange(cropped(event.currentTarget), 'DRAWN');
  if (!filled) { setFilled(true); setStatus('Signature added.'); }
 }
 function adopt() {
  const ctx = context(), name = typedName.trim();
  if (!ctx) return;
  if (!LATIN_NAME.test(name)) { setStatus(NAME_FIRST); return; }
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  paintName(ctx, name, '#111827');
  adopted.current = name; setFilled(true);
  onChange(cropped(canvas.current!), 'TYPED'); setStatus('Typed signature adopted.');
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
   <Button type="button" variant={mode === 'DRAWN' ? 'secondary' : 'outline'} aria-pressed={mode === 'DRAWN'} disabled={disabled} onClick={() => switchMode('DRAWN')}>Draw signature</Button>
   <Button type="button" variant={mode === 'TYPED' ? 'secondary' : 'outline'} aria-pressed={mode === 'TYPED'} disabled={disabled} onClick={() => switchMode('TYPED')}>Type signature</Button>
  </div>}
  <p id={`${id}-help`} className={`text-[13px] leading-5 text-muted-foreground ${compact && mode === 'DRAWN' ? 'max-lg:sr-only' : ''}`}>{instructions}</p>
  <div className={compact ? 'relative max-w-[440px] short:max-w-[240px]' : 'relative'}>
   <canvas ref={canvas} width={WIDTH} height={HEIGHT} role="img" aria-labelledby={`${id}-label`} aria-describedby={`${id}-state`}
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
    className={`block aspect-[2/1] w-full touch-none rounded-md border border-dashed border-input bg-white ${disabled ? 'opacity-60' : mode === 'DRAWN' ? 'cursor-crosshair' : ''}`}/>
   {/* A line to sign on. It isn't part of the image, which is cropped to what was drawn. */}
   <span aria-hidden="true" className="pointer-events-none absolute inset-x-4 bottom-[22%] border-b border-[#a8a29e]"/>
   {compact && filled && <Button type="button" size="sm" variant="outline" className="absolute right-2 top-2 bg-card" aria-label="Clear signature" disabled={disabled} onClick={() => reset('Signature cleared.')}>Clear</Button>}
  </div>
  <p id={`${id}-state`} className="sr-only">{filled ? 'A signature is in the box.' : 'The signature box is empty.'}</p>
  <div className="flex flex-wrap items-center justify-between gap-3">
   {/* Compact mode drops routine updates to save room, never one that says what to do next. */}
   <p role="status" aria-live="polite" className={status === NAME_FIRST || status === ADOPT_AGAIN ? 'text-[13px] leading-5 text-danger' : `text-[13px] leading-5 text-muted-foreground ${compact ? 'max-lg:sr-only' : ''}`}>{status}</p>
   <div className="flex flex-wrap gap-2">
    {mode === 'TYPED' && <Button type="button" disabled={disabled} onClick={adopt}>Adopt typed signature</Button>}
    {!compact && <Button type="button" variant="outline" disabled={disabled || !filled} onClick={() => reset('Signature cleared.')}>Clear signature</Button>}
   </div>
  </div>
 </div>;
}
