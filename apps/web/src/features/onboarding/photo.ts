// Photos are re-encoded in the browser before upload: a bounded JPEG that fits the upload limit and carries no
// camera metadata such as location. The API strips metadata segments again on its side. Returns base64 without the
// data-URL prefix.
const MAX_SIDE = 1600, MAX_BYTES = 2_400_000;
async function decode(file: File): Promise<CanvasImageSource & { width: number; height: number }> {
 if ('createImageBitmap' in window) return createImageBitmap(file, { imageOrientation: 'from-image' });
 const url = URL.createObjectURL(file);
 try { const image = new Image(); image.src = url; await image.decode(); return image; } finally { URL.revokeObjectURL(url); }
}
export async function photoForUpload(file: File): Promise<string> {
 if (!file.type.startsWith('image/')) throw new Error('Choose a photo (JPEG, PNG or HEIC).');
 let image;
 try { image = await decode(file); } catch { throw new Error('This photo could not be read. Take a new photo or choose a JPEG.'); }
 const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
 const canvas = document.createElement('canvas');
 canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
 canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
 for (const quality of [0.85, 0.7, 0.55]) {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (blob && blob.size <= MAX_BYTES) {
   const bytes = new Uint8Array(await blob.arrayBuffer());
   let binary = '';
   for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
   return btoa(binary);
  }
 }
 throw new Error('This photo is too large. Take a new photo with a lower resolution.');
}
