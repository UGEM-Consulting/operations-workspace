// Photos are re-encoded in the browser before upload: a bounded JPEG that fits the upload limit and carries no
// camera metadata such as location. The API strips metadata segments again on its side. Returns base64 without the
// data-URL prefix.
const MAX_SIDE = 1600, MAX_BYTES = 2_400_000;
/** A problem with the photo itself, with a message written for the person; any other error is unexpected. */
export class PhotoError extends Error {}
async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
 if ('createImageBitmap' in window) return createImageBitmap(file, { imageOrientation: 'from-image' });
 const url = URL.createObjectURL(file);
 try { const image = new Image(); image.src = url; await image.decode(); return image; } finally { URL.revokeObjectURL(url); }
}
/**
 * A photo as a bounded JPEG. `rotation` turns it clockwise in quarter turns (a document page photographed sideways);
 * smaller `maxBytes` lowers the quality until it fits, so several pages fit one upload.
 */
export async function imageForUpload(file: File, { maxSide = MAX_SIDE, maxBytes = MAX_BYTES, rotation = 0 }: { maxSide?: number; maxBytes?: number; rotation?: number } = {}): Promise<string> {
 if (!file.type.startsWith('image/')) throw new PhotoError('Choose a photo (JPEG, PNG or HEIC).');
 let image;
 try { image = await decode(file); } catch { throw new PhotoError('This photo could not be read. Take a new photo or choose a JPEG.'); }
 const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
 const width = Math.round(image.width * scale), height = Math.round(image.height * scale), turns = ((rotation % 4) + 4) % 4;
 const canvas = document.createElement('canvas');
 canvas.width = turns % 2 ? height : width; canvas.height = turns % 2 ? width : height;
 // Null when the browser runs out of canvas memory (older phones).
 const context = canvas.getContext('2d');
 if (!context) throw new PhotoError('This phone couldn’t prepare the photo. Close other apps or tabs and try again.');
 context.translate(canvas.width / 2, canvas.height / 2); context.rotate(turns * Math.PI / 2);
 context.drawImage(image, -width / 2, -height / 2, width, height);
 if ('close' in image) image.close();
 for (const quality of [0.85, 0.7, 0.55, 0.45]) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (blob && blob.size <= maxBytes) {
   const bytes = new Uint8Array(await blob.arrayBuffer());
   let binary = '';
   for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
   return btoa(binary);
  }
 }
 throw new PhotoError('This photo is too large. Take a new photo with a lower resolution.');
}
export const photoForUpload = (file: File) => imageForUpload(file);
