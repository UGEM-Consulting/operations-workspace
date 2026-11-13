// Snap to lines (Design System section 16, approved for building 2026-11-13): finds the empty lines a form leaves for a
// name, date or signature in a page drawn in the browser, and puts a field on one. Nothing is sent anywhere and nothing
// reads the text, so it works on scans. Fractions of the page, from its top left, like fields.
export interface FormLine { x: number; y: number; width: number }
export interface Box { x: number; y: number; width: number; height: number }

const DARK = 150, MAX_THICKNESS = 4, GAP = 2;
const dark = (pixels: Uint8ClampedArray, index: number) => pixels[index + 3] > 100 && pixels[index] * 0.3 + pixels[index + 1] * 0.59 + pixels[index + 2] * 0.11 < DARK;

/**
 * Thin dark horizontal lines in RGBA pixels: runs at least 4% of the page wide (and 30 pixels), at most 4 pixels thick. A line
 * with something printed on it (an underlined heading, a pre-filled date) isn't empty, so it isn't returned.
 */
export function findLines(pixels: Uint8ClampedArray, width: number, height: number): FormLine[] {
 const minimum = Math.max(30, Math.round(width * 0.04));
 // Each row's long runs, as [start, end) pixel spans.
 const rows: [number, number][][] = [];
 for (let y = 0; y < height; y += 1) {
  const runs: [number, number][] = [];
  let start = -1, last = -1;
  for (let x = 0; x < width; x += 1) {
   if (dark(pixels, (y * width + x) * 4)) { if (start < 0) start = x; last = x; }
   else if (start >= 0 && x - last > GAP) { if (last + 1 - start >= minimum) runs.push([start, last + 1]); start = -1; }
  }
  if (start >= 0 && last + 1 - start >= minimum) runs.push([start, last + 1]);
  rows.push(runs);
 }
 // Runs in neighbouring rows that overlap are one line; a block taller than MAX_THICKNESS is a box or a filled area, not a line.
 const used = rows.map(runs => runs.map(() => false)), lines: FormLine[] = [];
 for (let y = 0; y < height; y += 1) rows[y].forEach(([start, end], index) => {
  if (used[y][index]) return;
  used[y][index] = true;
  let bottom = y, left = start, right = end;
  for (let next = y + 1; next < height; next += 1) {
   const match = rows[next].findIndex(([a, b], at) => !used[next][at] && a < right && b > left);
   if (match < 0) break;
   used[next][match] = true; bottom = next; left = Math.min(left, rows[next][match][0]); right = Math.max(right, rows[next][match][1]);
  }
  if (bottom - y + 1 > MAX_THICKNESS) return;
  // Something printed just above it across its span means it isn't an empty line.
  let printed = 0, checked = 0;
  for (let above = Math.max(0, y - 10); above < Math.max(0, y - 2); above += 1) for (let x = left; x < right; x += 2) { checked += 1; if (dark(pixels, (above * width + x) * 4)) printed += 1; }
  if (checked && printed / checked > 0.04) return;
  lines.push({ x: left / width, y: (y + bottom + 1) / 2 / height, width: (right - left) / width });
 });
 return lines.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The line a point is nearest to, among lines that run under it, within `reach` of the page's height; any line when reach is null. */
export function nearestLine(lines: FormLine[], x: number, y: number, reach: number | null = 0.03): FormLine | null {
 let best: FormLine | null = null, distance = Infinity;
 for (const line of lines) {
  const across = x < line.x ? line.x - x : x > line.x + line.width ? x - line.x - line.width : 0;
  const gap = Math.abs(line.y - y) + across * (reach === null ? 1 : 3);
  if (reach !== null && (across > 0.02 || Math.abs(line.y - y) > reach)) continue;
  if (gap < distance) { best = line; distance = gap; }
 }
 return best;
}

/**
 * A field put on a line: from where the line starts, as wide as it, sitting just on it. Text keeps its height; a signature
 * is as tall as it can be without reaching the line above (or printed text), from 0.02 to 0.05 of the page.
 */
export function onLine(line: FormLine, kind: string, height: number, lines: FormLine[]): Box {
 let size = height;
 if (kind === 'SIGNATURE') {
  const above = lines.filter(other => other !== line && other.y < line.y - 0.005 && other.x < line.x + line.width && other.x + other.width > line.x).reduce((top, other) => Math.max(top, other.y), 0);
  size = Math.min(0.05, Math.max(0.02, above ? (line.y - above) * 0.7 : 0.05));
 }
 return { x: line.x, y: Math.max(0, line.y - size - 0.002), width: Math.min(line.width, 1 - line.x), height: size };
}

/** How much of a box is already printed on (dark), from 0 to 1, leaving out its bottom edge where its line is. */
export function printedShare(pixels: Uint8ClampedArray, width: number, height: number, box: Box): number {
 const left = Math.round(box.x * width), right = Math.round((box.x + box.width) * width), top = Math.round(box.y * height), bottom = Math.round((box.y + box.height) * height) - 3;
 let printed = 0, checked = 0;
 for (let y = Math.max(0, top); y < Math.min(height, bottom); y += 1) for (let x = Math.max(0, left); x < Math.min(width, right); x += 1) { checked += 1; if (dark(pixels, (y * width + x) * 4)) printed += 1; }
 return checked ? printed / checked : 0;
}

/** Whether two boxes on the same page overlap. */
export const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
