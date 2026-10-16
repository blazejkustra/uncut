// The landing page (was site/index.html): the hero with its WebGPU background, the agent, the editor
// underneath, privacy and the closing call.
import type { Metadata } from "next";
import DownloadButtons from "../components/DownloadButtons.tsx";
import HeroFx from "../components/HeroFx.tsx";
import { ClaudeMark, CodexMark } from "../components/Icons.tsx";
import SiteFooter from "../components/SiteFooter.tsx";
import SiteHeader from "../components/SiteHeader.tsx";
import { alternates, SITE_URL } from "../lib/site.ts";

export const metadata: Metadata = {
  title: { absolute: "Uncut: edit videos by talking to an agent" },
  description: "Uncut is an AI-first video editor for the Mac. It runs your installed Claude Code, which edits with you on a real timeline. Free and open source.",
  alternates: alternates("/"),
  openGraph: {
    type: "website",
    title: "Uncut",
    description: "Edit videos by talking to an agent. An AI-first video editor for the Mac.",
    url: `${SITE_URL}/`,
    images: [`${SITE_URL}/assets/img/og.jpg`],
  },
  twitter: { card: "summary_large_image" },
};

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main>
        <div className="hero">
          <HeroFx />
          <div className="wrap">
            <h1>Edit videos by talking to an agent</h1>
            <p className="lede">
              Uncut is a video editor for the Mac with an agent built in. It runs your installed{" "}
              <span className="who"><ClaudeMark />Claude{" "}Code</span>, with{" "}
              <span className="who"><CodexMark />Codex</span> coming soon. The agent plans the cut, edits a real timeline while you watch, and hands every change back to you to keep or undo.
            </p>
            <DownloadButtons />
            <p className="req">For Apple silicon Macs. Free and open source.</p>
            <img className="shot" src="/assets/img/editor.webp" width={1600} height={1000} fetchPriority="high" alt="The Uncut editor cutting a travel film from drone footage: a media library of Croatian coast clips, the title Day four over a coastal road at golden hour in the preview, a timeline with text, graphics, six clips with transitions and music, and the agent panel with its brief, an approved storyboard and a passed review." />
          </div>
        </div>

        <section id="features">
          <div className="wrap agent">
            <div>
              <h2>It edits the timeline live, and you stay in charge</h2>
              <p className="sub">Ask for a cut the way you would ask an editor. The agent sees your timeline, your footage and its transcript, and makes the edit right where you can watch it happen.</p>
              <ul>
                <li><strong>Plans before it cuts.</strong> A brief and a storyboard come first, for you to approve or change.</li>
                <li><strong>Reviewed by a critic.</strong> An independent pass checks the edit against the plan and sends it back when it falls short.</li>
                <li><strong>Every turn is one undo.</strong> Keep what works, undo the rest, or keep editing by hand on the same timeline.</li>
              </ul>
            </div>
            <div className="panels">
              <img className="panel-img" src="/assets/img/agent-turn.webp" width={620} height={730} loading="lazy" alt="An agent turn: it reads the transcript, cuts filler words and long pauses, appends the cleanest take and reports 3 edits with an undo button." />
              <img className="panel-img" src="/assets/img/agent-review.webp" width={620} height={750} loading="lazy" alt="A passed review from the independent critic, with scores for the hook, phone readability, motion, variety and sound sync." />
            </div>
          </div>
        </section>

        <section>
          <div className="wrap">
            <h2>A real editor underneath</h2>
            <p className="sub">Tracks, trims, splits, snapping, keyframes and a mixer with ducking. Everything the agent does, you can do yourself.</p>
            <div className="cards">
              <article className="card">
                <div className="crop"><img src="/assets/img/transcript.webp" width={520} height={1040} loading="lazy" alt="The transcript panel with buttons to remove filler words and pauses, and the transcribed talk below." /></div>
                <div className="body">
                  <h3>Edit by transcript</h3>
                  <p>Local transcription on your Mac. Remove fillers and long pauses in one click, or cut by the words.</p>
                </div>
              </article>
              <article className="card">
                <div className="crop"><img src="/assets/img/text.webp" width={520} height={1040} loading="lazy" alt="Text presets: title, lower third, big title, kicker, highlight word, caption, stroked title and outline." /></div>
                <div className="body">
                  <h3>Captions and titles</h3>
                  <p>Burned-in or word by word captions, SRT and WebVTT in and out, and animated titles, lower thirds and end cards.</p>
                </div>
              </article>
              <article className="card">
                <div className="crop"><img src="/assets/img/sounds.webp" width={520} height={1040} loading="lazy" alt="The sound effects panel with a search box and a list of sounds with waveforms." /></div>
                <div className="body">
                  <h3>Sound effects and music</h3>
                  <p>A built-in sound library, online sound search, and a mixer that ducks the music under speech.</p>
                </div>
              </article>
              <article className="card">
                <div className="crop"><img src="/assets/img/capture.webp" width={520} height={700} loading="lazy" alt="The capture panel with screen recording and a list of simulators and emulators to record." /></div>
                <div className="body">
                  <h3>Capture</h3>
                  <p>Record your screen, camera and mic, or iOS simulators, Android emulators and apps, straight into the project.</p>
                </div>
              </article>
            </div>
            <div className="facts">
              <div className="fact">
                <h3>Effects and looks</h3>
                <p>Filters, colour looks, transitions and text animations, previewed on the GPU.</p>
              </div>
              <div className="fact">
                <h3>Plugins</h3>
                <p>Looks, components, checks and agent tools in a folder, with a catalog to browse.</p>
              </div>
              <div className="fact">
                <h3>Export</h3>
                <p>H.264 at the quality you pick, with loudness for social or broadcast and optional subtitles.</p>
              </div>
            </div>
          </div>
        </section>

        <section>
          <div className="wrap">
            <h2>Your footage stays with you</h2>
            <p className="sub">Uncut runs on your Mac, and so does transcription. The agent is your own Claude Code, with whatever sign-in it already uses, billed to you as your Claude Code usage normally is. Usage data is anonymous, and you can turn it off.</p>
            <p className="sub"><a href="/privacy/">Read the privacy notice</a></p>
          </div>
        </section>

        <section className="cta">
          <div className="wrap">
            <h2>Start your next cut</h2>
            <p className="sub">Install Claude Code and sign in, then open Uncut and tell it what to make.</p>
            <DownloadButtons />
            <p className="req">For Apple silicon Macs.</p>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
