'use client';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
const WIDTH = 600, HEIGHT = 180;
/** Draw-to-sign with mouse, pen or finger. Reports a transparent PNG data URL, or null when cleared. */
export function SignaturePad({ label, onChange, disabled = false }: { label: string; onChange: (dataUrl: string | null) => void; disabled?: boolean }) {
 const canvas = useRef<HTMLCanvasElement>(null), drawing = useRef(false), strokes = useRef(0);
 useEffect(() => {
  const context = canvas.current?.getContext('2d');
  if (!context) return;
  context.lineWidth = 3; context.lineCap = 'round'; context.lineJoin = 'round'; context.strokeStyle = '#111827';
 }, []);
 function point(event: React.PointerEvent<HTMLCanvasElement>) {
  const box = event.currentTarget.getBoundingClientRect();
  return [(event.clientX - box.left) * WIDTH / box.width, (event.clientY - box.top) * HEIGHT / box.height] as const;
 }
 function start(event: React.PointerEvent<HTMLCanvasElement>) {
  if (disabled) return;
  event.currentTarget.setPointerCapture(event.pointerId);
  const context = event.currentTarget.getContext('2d')!, [x, y] = point(event);
  drawing.current = true; context.beginPath(); context.moveTo(x, y); context.lineTo(x + 0.1, y + 0.1); context.stroke();
 }
 function move(event: React.PointerEvent<HTMLCanvasElement>) {
  if (!drawing.current) return;
  const context = event.currentTarget.getContext('2d')!, [x, y] = point(event);
  context.lineTo(x, y); context.stroke();
 }
 function end(event: React.PointerEvent<HTMLCanvasElement>) {
  if (!drawing.current) return;
  drawing.current = false; strokes.current += 1;
  onChange(event.currentTarget.toDataURL('image/png'));
 }
 function clear() {
  canvas.current?.getContext('2d')?.clearRect(0, 0, WIDTH, HEIGHT);
  strokes.current = 0; onChange(null);
 }
 return <div className="space-y-2">
  <p className="text-sm">{label}</p>
  <canvas ref={canvas} width={WIDTH} height={HEIGHT} role="img" aria-label={`${label} drawing area`}
   onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
   className={`aspect-[10/3] w-full touch-none rounded-lg border border-dashed border-border bg-white ${disabled ? 'opacity-60' : 'cursor-crosshair'}`}/>
  <div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">Sign with your mouse, pen or finger.</p><Button type="button" variant="outline" disabled={disabled} onClick={clear}>Clear signature</Button></div>
 </div>;
}
