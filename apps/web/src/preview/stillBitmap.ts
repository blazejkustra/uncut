// A still's picture decoded once, off the main thread, for WebGL to upload. texImage2D from an <img>
// decodes the file again on the main thread on every call (a 12 MP photo: ~60 ms each, measured in
// the app; img.decode() doesn't spare it), and a still with effects under a copy of itself (a
// blurred backdrop) was uploaded twice at its cut: ~150 ms of a frozen preview at every photo.
// From an ImageBitmap the same upload takes ~5 ms. The bitmap is made when the <img> loads (the
// Compositor makes the next stills two seconds ahead), is what the GPU compositor and the effects
// renderer upload in place of the <img>, and is closed when the <img> is dropped.

// The bitmap is premultiplied, and WebGL ignores UNPACK_PREMULTIPLY_ALPHA_WEBGL for an ImageBitmap:
// an upload that wants straight alpha (the effects renderer) takes it only from a JPEG, which has none.
type Still = { readonly bitmap: ImageBitmap; readonly opaque: boolean };

const stills = new WeakMap<HTMLImageElement, Still>();
const pending = new WeakSet<HTMLImageElement>();

/** Starts decoding a loaded <img> into its bitmap (once; nothing for an SVG, which isn't a fixed raster). */
export function prepareStill(img: HTMLImageElement) {
  if (pending.has(img) || stills.has(img) || !img.complete || !img.naturalWidth || /\.svg($|[?#&])/i.test(img.currentSrc)) return;
  pending.add(img);
  const src = img.currentSrc;
  // From the file's bytes (the HTTP cache has them), not the <img>: createImageBitmap(img) decodes on
  // the main thread (~50 ms for a 12 MP photo), from a Blob on a worker. EXIF orientation applies
  // either way (imageOrientation "from-image"), as the <img> shows it.
  fetch(src)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then(decodeStill)
    .then(
      (still) => {
        pending.delete(img);
        // Dropped, or given another file, while it decoded.
        if (!img.isConnected || img.currentSrc !== src) return still.bitmap.close();
        stills.set(img, still);
      },
      () => pending.delete(img),
    );
}

async function decodeStill(blob: Blob): Promise<Still> {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  return { bitmap, opaque: await isJpeg(blob) };
}

async function isJpeg(blob: Blob) {
  const head = new Uint8Array(await blob.slice(0, 3).arrayBuffer());
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

/** What WebGL should upload for this source: a still's bitmap once it's there, else the source itself. */
export function uploadable<T extends TexImageSource>(source: T, { straight = false } = {}): T | ImageBitmap {
  const still = source instanceof HTMLImageElement ? stills.get(source) : undefined;
  return still && (still.opaque || !straight) ? still.bitmap : source;
}

/** The <img> is going: its bitmap's memory (48 MB for a 12 MP photo) is freed now. */
export function releaseStill(img: HTMLImageElement) {
  stills.get(img)?.bitmap.close();
  stills.delete(img);
}
