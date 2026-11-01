import type { Metadata } from "next";
import DownloadButtons from "../../components/DownloadButtons.tsx";
import { EmailLink, InterestButton } from "../../components/ProInterest.tsx";
import SiteFooter from "../../components/SiteFooter.tsx";
import SiteHeader from "../../components/SiteHeader.tsx";
import { alternates, SITE_URL } from "../../lib/site.ts";

const DESCRIPTION = "Uncut is free and open source. Uncut Pro is a planned set of hosted features at $15 per editor per month. It does not exist yet.";
const EMAIL = "kustrablazej@gmail.com";
const MAILTO = `mailto:${EMAIL}?subject=${encodeURIComponent("Email me when Uncut Pro exists")}`;

const PRO_IDEAS = [
  {
    feature: "review_links",
    name: "hosted review links",
    title: "Hosted review links",
    benefit: "Send a client a link. They comment on the exact frame in a browser with no install, and the notes appear on your timeline as they write.",
  },
  {
    feature: "team_projects",
    name: "team projects",
    title: "Team projects",
    benefit: "Editors on a team open the same project and the same footage, with no drives to post and no folders to keep in step.",
  },
  {
    feature: "visual_search",
    name: "visual search",
    title: "Visual search across all your footage",
    benefit: "Every shot is indexed when it comes in, so you can type what you remember seeing and jump to it, without spending your agent's usage.",
  },
  {
    feature: "cloud_render",
    name: "cloud render",
    title: "Cloud render",
    benefit: "Send the export to our machines and keep cutting while your Mac stays free.",
  },
  {
    feature: "hosted_proxies",
    name: "hosted proxies",
    title: "Hosted proxies",
    benefit: "Light copies of your footage follow the project, so you can pick up the edit on another machine with the originals left at home.",
  },
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
      <main className="wrap">
        <div className="blog pricing">
          <h1>Pricing</h1>
          <p className="sub">
            Uncut is free and stays free. Uncut Pro does not exist yet: nothing here charges you, and clicking a button only tells us what to build.
          </p>

          <section className="plan" aria-labelledby="plan-free">
            <div className="plan-head">
              <h2 id="plan-free">Free</h2>
              <p className="plan-price">$0</p>
            </div>
            <p>
              Everything Uncut does today, and it stays free: the agent, the timeline, local transcription, captions, sound, effects, plugins and export. MIT
              licensed, with no Uncut account. You bring your own Claude Code or Codex sign-in, and your agent's usage is billed the way it normally is.
            </p>
            <DownloadButtons />
          </section>

          <section className="plan" aria-labelledby="plan-pro">
            <div className="plan-head">
              <h2 id="plan-pro">Uncut Pro (planned)</h2>
              <p className="plan-price">
                $15 <span>per editor per month</span>
              </p>
            </div>
            <p>
              Not built yet. These ideas need servers, so they would be paid. The price is what we expect to ask, and it is here so you can tell us whether it
              is worth it. There is no checkout and no signup.
            </p>
            <ul className="pro-rows">
              {PRO_IDEAS.map((idea) => (
                <li key={idea.feature}>
                  <div>
                    <h3>{idea.title}</h3>
                    <p>{idea.benefit}</p>
                  </div>
                  <InterestButton feature={idea.feature} name={idea.name} />
                </li>
              ))}
            </ul>
            <div className="actions">
              <EmailLink href={MAILTO} />
            </div>
            <p className="pro-note pro-email">
              Pro does not exist yet and nothing is charged. This opens your mail app, addressed to {EMAIL}, and tells us you would like to hear when it does.
            </p>
          </section>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
