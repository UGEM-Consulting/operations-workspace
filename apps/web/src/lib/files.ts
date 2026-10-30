/** The API's limit for an uploaded company document or MVR PDF. */
export const MAX_PDF_BYTES = 3_000_000;

/** Base64 for an upload body, in chunks so a large file never overflows the argument list. */
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
export const fileToBase64 = async (file: Blob) => toBase64(new Uint8Array(await file.arrayBuffer()));
