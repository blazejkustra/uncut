// Cloudflare Pages middleware (D284): tags each page view with a coarse region, "eu" or "other", in
// the uncut_region cookie, so the static pages know whether to ask for analytics consent
// (site/src/analytics.ts). The country itself is never stored. Unknown country counts as EU.
// `?region=eu|other` overrides it for testing. Only HTML pages run this (site/_routes.json).
// Deployed only when wrangler runs inside site/ (it looks for ./functions): see site/DEPLOY.txt.
import { REGION_COOKIE, type Region, regionFromCookies, regionOf } from "../src/consent.ts";

type Context = {
  request: Request & { cf?: { country?: string } };
  next: () => Promise<Response>;
};

export function regionFor(request: Context["request"]): Region {
  const override = new URL(request.url).searchParams.get("region");
  if (override === "eu" || override === "other") return override;
  return regionOf(request.headers.get("CF-IPCountry") ?? request.cf?.country);
}

export async function onRequest(context: Context): Promise<Response> {
  const { request } = context;
  const response = await context.next();
  if (!(response.headers.get("content-type") ?? "").includes("text/html")) return response;
  const region = regionFor(request);
  const cookies = request.headers.get("Cookie") ?? "";
  const current = cookies.includes(`${REGION_COOKIE}=`) ? regionFromCookies(cookies) : null;
  if (current === region) return response;
  const out = new Response(response.body, response);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  out.headers.append("Set-Cookie", `${REGION_COOKIE}=${region}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax${secure}`);
  return out;
}
