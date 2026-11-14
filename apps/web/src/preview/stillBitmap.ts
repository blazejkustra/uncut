// A still's picture decoded once, off the main thread, for WebGL to upload. texImage2D from an <img>
// decodes the file again on the main thread on every call (a 12 MP photo: ~60 ms each, measured in
// the app; img.decode() doesn't spare it), and a still with effects under a copy of itself (a
// blurred backdrop) was uploaded twice at its cut: ~150 ms of a frozen preview at every photo.
// From an ImageBitmap the same upload takes ~5 ms. The bitmap is made when the <img> loads (the
// Compositor makes the next stills two seconds ahead), is what the GPU compositor and the effects
// renderer upload in place of the <img>, and is closed when the <img> is dropped.

const bitmaps = new WeakMap<HTMLImageElement, ImageBitmap>();
const pending = new WeakSet<HTMLImageElement>();

/** Starts decoding a loaded <img> into its bitmap (once; nothing for an SVG, which isn't a fixed raster). */
export function prepareStill(img: HTMLImageElement) {
  if (pending.has(img) || bitmaps.has(img) || !img.complete || !img.naturalWidth || /\.svg($|[?#&])/i.test(img.currentSrc)) return;
  pending.add(img);
  const src = img.currentSrc;
  // From the file's bytes (the HTTP cache has them), not the <img>: createImageBitmap(img) decodes on
  // the main thread (~50 ms for a 12 MP photo), from a Blob on a worker. EXIF orientation applies
  // either way (imageOrientation "from-image"), as the <img> shows it.
  fetch(src)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((blob) => createImageBitmap(blob, { imageOrientation: "from-image" }))
    .then(
      (bitmap) => {
        pending.delete(img);
        // Dropped, or given another file, while it decoded.
        if (!img.isConnected || img.currentSrc !== src) return bitmap.close();
        bitmaps.set(img, bitmap);
      },
      () => pending.delete(img),
    );
}

/** What WebGL should upload for this source: a still's bitmap once it's there, else the source itself. */
export function uploadable<T extends TexImageSource>(source: T): T | ImageBitmap {
  return source instanceof HTMLImageElement ? (bitmaps.get(source) ?? source) : source;
}

/** The <img> is going: its bitmap's memory (48 MB for a 12 MP photo) is freed now. */
export function releaseStill(img: HTMLImageElement) {
  bitmaps.get(img)?.close();
  bitmaps.delete(img);
}
