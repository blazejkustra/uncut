// What tests reach for inside the app's renderer through page.evaluate.
export {};

declare global {
  interface Window {
    /** The desktop preload's bridge (apps/desktop/src/preload.ts). */
    uncut?: any;
    /** A socket a test holds open in the page. */
    __held?: any;
  }
}
