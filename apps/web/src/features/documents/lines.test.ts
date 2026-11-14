import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findLines, nearestLine, onLine, overlaps, printedShare } from './lines.ts';

/** A white page with dark rectangles drawn on it. */
function page(width: number, height: number, marks: [number, number, number, number][]) {
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y, w, h] of marks) for (let row = y; row < y + h; row += 1) for (let col = x; col < x + w; col += 1) { const at = (row * width + col) * 4; pixels[at] = pixels[at + 1] = pixels[at + 2] = 20; }
  return pixels;
}

describe('snap to lines', () => {
  it('finds thin empty lines and leaves out boxes, short dashes and underlined text', () => {
    const pixels = page(500, 400, [
      [50, 100, 200, 2],            // an empty line for a name
      [300, 100, 25, 1],            // too short to be a line
      [50, 200, 300, 12],           // a filled box, not a line
      [50, 300, 200, 2], [60, 292, 120, 6], // a line with text printed on it: an underlined heading
      [320, 350, 120, 1],           // another empty line
    ]);
    const lines = findLines(pixels, 500, 400);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(line => [Math.round(line.x * 500), Math.round(line.y * 400), Math.round(line.width * 500)]), [[50, 101, 200], [320, 351, 120]]);
  });
  it('leaves out the flat top of a word, which has letters right under it', () => {
    // A word in small letters: its top edge is one solid row, with letter strokes in the rows under it.
    const word: [number, number, number, number][] = [[100, 50, 80, 1], ...Array.from({ length: 10 }, (_, at): [number, number, number, number] => [100 + at * 8, 51, 3, 8])];
    assert.equal(findLines(page(400, 100, word), 400, 100).length, 0);
  });
  it('joins a line drawn with small gaps, as scans often are', () => {
    const lines = findLines(page(400, 100, [[20, 50, 100, 1], [122, 50, 100, 1]]), 400, 100);
    assert.equal(lines.length, 1);
    assert.equal(Math.round(lines[0].width * 400), 202);
  });
  it('takes the nearest line under a drop, and nothing far from every line', () => {
    const lines = [{ x: 0.1, y: 0.3, width: 0.4 }, { x: 0.1, y: 0.35, width: 0.4 }];
    assert.equal(nearestLine(lines, 0.2, 0.34), lines[1]);
    assert.equal(nearestLine(lines, 0.2, 0.6), null);
    assert.equal(nearestLine(lines, 0.8, 0.3), null);
    assert.equal(nearestLine(lines, 0.8, 0.6, null), lines[1]);
  });
  it('puts a field on its line, as wide as it, and keeps a signature under the line above', () => {
    const name = { x: 0.1, y: 0.5, width: 0.3 }, above = { x: 0.1, y: 0.47, width: 0.3 };
    const text = onLine(name, 'NAME', 0.018, [name]);
    assert.deepEqual([text.x, text.width, +(text.y + text.height).toFixed(3)], [0.1, 0.3, 0.498]);
    const signature = onLine(name, 'SIGNATURE', 0.02, [above, name]);
    assert.ok(signature.y >= above.y, 'the signature stays below the line above');
    assert.ok(signature.height >= 0.02);
  });
  it('measures what a field would cover, and finds fields that overlap', () => {
    const pixels = page(100, 100, [[10, 10, 20, 5]]);
    assert.ok(printedShare(pixels, 100, 100, { x: 0.1, y: 0.08, width: 0.2, height: 0.1 }) > 0.2);
    assert.equal(printedShare(pixels, 100, 100, { x: 0.5, y: 0.5, width: 0.2, height: 0.1 }), 0);
    assert.equal(overlaps({ x: 0, y: 0, width: 0.2, height: 0.1 }, { x: 0.1, y: 0.05, width: 0.2, height: 0.1 }), true);
    assert.equal(overlaps({ x: 0, y: 0, width: 0.2, height: 0.1 }, { x: 0.3, y: 0, width: 0.2, height: 0.1 }), false);
  });
});
