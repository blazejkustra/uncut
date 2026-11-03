import type { Metadata } from "next";
import DownloadButtons from "../../components/DownloadButtons.tsx";
import { GetPro } from "../../components/ProInterest.tsx";
import SiteFooter from "../../components/SiteFooter.tsx";
import SiteHeader from "../../components/SiteHeader.tsx";
import { alternates, SITE_URL } from "../../lib/site.ts";

const DESCRIPTION =
  "Uncut is free and open source. Uncut Pro adds review links, team projects, visual search, cloud render and hosted proxies for $15 per editor per month.";
const EMAIL = "kustrablazej@gmail.com";

const FREE_FEATURES = [
  "The agent, with your own Claude Code or Codex sign-in",
  "A real timeline you can edit by hand",
  "Local transcription, captions and titles",
  "Sound library, effects, transitions and plugins",
  "Export in H.264 or HEVC",
  "MIT licensed, no Uncut account",
];

const PRO_FEATURES = [
  { feature: "review_links", title: "Review links", line: "Clients comment on the exact frame in a browser, and the notes land on your timeline." },
  { feature: "team_projects", title: "Team projects", line: "Your whole team opens the same project and footage." },
  { feature: "visual_search", title: "Visual search", line: "Type what you remember seeing and jump to the shot, across all your footage." },
  { feature: "cloud_render", title: "Cloud render", line: "Exports render on our machines while you keep editing." },
  { feature: "hosted_proxies", title: "Hosted proxies", line: "Pick up the edit on another Mac without copying the originals." },
];

export const metadata: Metadata = {
  title: "Pricing",
  description: DESCRIPTION,
  alternates: alternates("/pricing/"),
  openGraph: { type: "website", title: "Uncut pricing", description: DESCRIPTION, url: `${SITE_URL}/pricing/`, images: [`${SITE_URL}/assets/img/og.jpg`] },
  twitter: { card: "summary_large_image" },
};

export default function Pricing() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="wrap">
        <div className="blog pricing">
          <h1>Pricing</h1>
          <p className="sub">Uncut is free and open source. Pro adds hosted features for client review and teams.</p>

          <section className="plan" aria-labelledby="plan-free">
            <div className="plan-head">
              <h2 id="plan-free">Free</h2>
              <p className="plan-price">$0</p>
            </div>
            <p>Everything Uncut does today. Your agent's usage is billed the way it normally is.</p>
            <ul className="plan-list">
              {FREE_FEATURES.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <DownloadButtons />
          </section>

          <section className="plan" aria-labelledby="plan-pro">
            <div className="plan-head">
              <h2 id="plan-pro">Pro</h2>
              <p className="plan-price">
                $15 <span>per editor per month</span>
              </p>
            </div>
            <p>Everything in Free, plus:</p>
            <ul className="plan-list">
              {PRO_FEATURES.map((f) => (
                <li key={f.feature}>
                  <strong>{f.title}.</strong> {f.line}
                </li>
              ))}
            </ul>
            <div className="actions">
              <GetPro email={EMAIL} features={PRO_FEATURES.map(({ feature, title }) => ({ feature, title }))} />
            </div>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
