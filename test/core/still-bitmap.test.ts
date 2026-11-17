// A still's decoded bitmap, without the app: WebGL uploads it in place of the <img>, but it is
// premultiplied (WebGL ignores UNPACK_PREMULTIPLY_ALPHA_WEBGL for a bitmap), so an upload that wants
// straight alpha takes it only from a JPEG; a dropped <img>'s bitmap is closed.
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeImage {
  complete = true;
  naturalWidth = 4;
  isConnected = true;
  readonly currentSrc: string;
  constructor(src: string) {
    this.currentSrc = src;
  }
}
class FakeBitmap {
  closed = false;
  close() {
    this.closed = true;
  }
}
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
Object.assign(globalThis, {
  HTMLImageElement: FakeImage,
  fetch: async (src: string) => new Response(new Blob([src.endsWith(".jpg") ? JPEG : PNG])),
  createImageBitmap: async () => new FakeBitmap(),
});
const { prepareStill, uploadable, releaseStill } = await import("../../apps/web/src/preview/stillBitmap.ts");

async function prepared(src: string) {
  const img = new FakeImage(src) as unknown as HTMLImageElement;
  prepareStill(img);
  await new Promise((r) => setTimeout(r, 10));
  return img;
}

test("a JPEG's bitmap is uploaded either way", async () => {
  const img = await prepared("/media/photo.jpg");
  assert.ok(uploadable(img) instanceof FakeBitmap);
  assert.ok(uploadable(img, { straight: true }) instanceof FakeBitmap);
});

test("a PNG's premultiplied bitmap is not uploaded where straight alpha is wanted", async () => {
  const img = await prepared("/media/logo.png");
  assert.ok(uploadable(img) instanceof FakeBitmap);
  assert.equal(uploadable(img, { straight: true }), img);
});

test("a dropped still's bitmap is closed and no longer uploaded", async () => {
  const img = await prepared("/media/photo.jpg");
  const bitmap = uploadable(img) as unknown as FakeBitmap;
  releaseStill(img);
  assert.ok(bitmap.closed);
  assert.equal(uploadable(img), img);
});
