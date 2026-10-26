/** A private photo served through the same-origin BFF with the viewer's session. next/image cannot proxy or cache it. */
export function PrivateImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} className={className} />;
}
