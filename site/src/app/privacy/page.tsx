// The privacy notice for the app and this website (was site/privacy/index.html).
import type { Metadata } from "next";
import { alternates } from "../../lib/site.ts";
import SiteFooter from "../../components/SiteFooter.tsx";
import SiteHeader from "../../components/SiteHeader.tsx";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Uncut sends, when, and where it goes.",
  alternates: alternates("/privacy/"),
};

export default function Privacy() {
  return (
    <>
      <SiteHeader />
      <main className="wrap">
        <article className="doc">
          <h1>Privacy</h1>
          <p className="meta">The Uncut app and this website</p>

          <h2>Who is responsible</h2>
          <p>Uncut is made by Błażej Kustra, who is the controller for the usage data and the website analytics below. Contact: <a href="mailto:kustrablazej@gmail.com">kustrablazej@gmail.com</a>.</p>
          <p>This website uses Google Analytics; see <a href="#website">Website</a>.</p>

          <h2>Usage data</h2>
          <p><strong>Usage data is anonymous and on by default.</strong> Uncut sends a few counts so we know how many people use it and what breaks. No identifier of any kind is sent: no install id, no session id, nothing derived from your Mac, your name or your account. Turn it off any time in Settings › App › Usage data (it stays off), or set <code>DO_NOT_TRACK=1</code> or <code>UNCUT_TELEMETRY=off</code>; then nothing is sent. Builds made from source send nothing either way. The legal basis is our legitimate interest in knowing how Uncut is used and fixing crashes; turning it off is your objection, and it takes effect at once.</p>
          <p>Uncut sends only these events, each with the app version, macOS or Linux, the processor type and whether it runs in the desktop app:</p>
          <ul>
            <li><code>app:start</code>: the app started (and whether it runs headless).</li>
            <li><code>app:crash</code>: which process crashed, the error's class name and code, and a fingerprint of the top stack frames with folders and messages removed.</li>
            <li><code>export:complete</code>, <code>export:fail</code>, <code>export:cancel</code>: how long the export took, its length, quality, codec, encoder, size and frame rate, whether it was a range or had subtitles, or the stage that failed.</li>
            <li><code>agent:turn</code>, <code>agent:fail</code>: whether an agent turn finished, failed or was cancelled, how long it took, how many edits and steps, or a fixed word for why it failed (usage limit, rate limit, signed out and so on).</li>
          </ul>
          <p>Never your footage, frames, transcripts, prompts, file names, paths or error messages. The events go through a Cloudflare Worker to Grafana Cloud's logs service in the EU, where they are kept for 14 days (the plan's retention) and then deleted. The Worker keeps no request logs and doesn't forward your IP address. To count daily users, our server computes a one-way hash of your IP address with a key that is replaced every day, then discards the IP; it can't be linked across days or to you.</p>

          <h2>What else leaves your Mac</h2>
          <p>Only when you use it:</p>
          <ul>
            <li><strong>The agent.</strong> Uncut runs your own Claude Code, which sends Anthropic what the agent works with: your prompts, frames from your video, transcripts, file and project names, under your Claude Code account and Anthropic's terms.</li>
            <li><strong>Generators.</strong> Image, video and sound effect generators send your prompts (and any image you give them) to OpenAI, Google or ElevenLabs with your own API keys, under their terms.</li>
            <li><strong>Sound search.</strong> Searching for sounds online sends the search words to Openverse, or to Freesound with your key.</li>
            <li><strong>Downloads.</strong> The speech model comes from Hugging Face; updates are checked for and downloaded from GitHub, which sees your IP address and the app version.</li>
          </ul>
          <p>Uncut is not made by or affiliated with Anthropic.</p>

          <h2 id="website">Website</h2>
          <p>This website (uncut.video) uses Google Analytics 4 to see how visitors find and use it. Google Analytics is provided by Google Ireland Limited, which processes the data for us under Google's terms (Google is also a controller for some uses, as its terms describe). It collects the pages you view, where you came from, your approximate location (country and city, from your IP address, which Google Analytics doesn't store), your device, browser and screen size, and how long you stay. It sets the cookies <code>_ga</code> and <code>_ga_&lt;id&gt;</code>, which hold a random identifier and last up to 2 years. Data in Google Analytics is kept for 14 months and then deleted. Google may process it outside the European Economic Area under the EU-U.S. Data Privacy Framework or the European Commission's standard contractual clauses.</p>
          <p>If you visit from the European Economic Area, the United Kingdom or Switzerland (or we can't tell where you are), Google Analytics doesn't load at all unless you accept it in the cookie banner; the legal basis is then your consent. You can change your choice at any time with the &ldquo;Cookie settings&rdquo; link in the website footer; rejecting removes the Google Analytics cookies. Elsewhere it loads without a banner, on the basis of our legitimate interest in knowing how the website is used. We also set a cookie, <code>uncut_region</code>, that records only &ldquo;eu&rdquo; or &ldquo;other&rdquo; for 30 days, so we know whether to show the banner, and we store your choice in your browser's local storage for 12 months.</p>
        </article>
      </main>
      <SiteFooter home />
    </>
  );
}
