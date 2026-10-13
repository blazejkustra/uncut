// The secret of the graphic documents route (D78), apart from the server token.
import { createHmac } from "node:crypto";

/**
 * The only secret this route accepts (D78): derived from the server token, so it can't be turned
 * back into it, and no other route or the WebSocket accepts it. The graphic's own script can read
 * its URL, so the server token must never be in it.
 */
export const graphicToken = (token: string) => createHmac("sha256", token).update("uncut-graphic-documents").digest("base64url");

