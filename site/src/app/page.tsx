// The landing page (was site/index.html): the hero with its WebGPU background, the launch film, a section per feature,
// privacy and the closing call.
import type { Metadata } from "next";
import { Fragment, type ReactNode } from "react";
import AgentPlayback from "../components/motion/AgentPlayback.tsx";
import CriticPlayback from "../components/motion/CriticPlayback.tsx";
import TimelineShot from "../components/motion/TimelineShot.tsx";
import TranscriptWords from "../components/motion/TranscriptWords.tsx";
import DownloadButtons from "../components/DownloadButtons.tsx";
import HeroFx from "../components/HeroFx.tsx";
import JsonLd from "../components/JsonLd.tsx";
import LaunchFilm from "../components/LaunchFilm.tsx";
import ScrollReveal from "../components/ScrollReveal.tsx";
import { ClaudeMark, CodexMark } from "../components/Icons.tsx";
import SiteFooter from "../components/SiteFooter.tsx";
import SiteHeader from "../components/SiteHeader.tsx";
import ZoomShot from "../components/ZoomShot.tsx";
import { alternates, DOWNLOAD_URL, REPO_URL, SITE_NAME, SITE_URL } from "../lib/site.ts";
import "./motion.css";

const DESCRIPTION =
  "Uncut is an AI-first video editor for the Mac. It runs your installed Claude Code or Codex, which edits with you on a real timeline. Free and open source.";

export const metadata: Metadata = {
  title: { absolute: "Uncut: edit videos by talking to an agent" },
  description: DESCRIPTION,
  alternates: alternates("/"),
  openGraph: {
    type: "website",
    title: "Uncut, the open-source AI video editor",
    description: "Edit videos by talking to an agent. An AI-first video editor for the Mac.",
    url: `${SITE_URL}/`,
    images: [`${SITE_URL}/assets/img/og.jpg`],
  },
  twitter: { card: "summary_large_image" },
};

/** The heading's words as separate spans, so each can rise in on its own (globals.css, .hero h1 .w). */
function Words({ text }: { text: string }) {
  return text.split(" ").map((word, i) => (
    <Fragment key={i}>
      {i > 0 ? " " : null}
      <span className="w">{word}</span>
    </Fragment>
  ));
}

const MORE: Array<[string, string]> = [
  ["Sound and music", "A built-in sound library, online sound search and music ducked under speech."],
  ["Effects and looks", "Filters, colour looks, transitions and text animations, previewed on the GPU."],
  ["Plugins", "Looks, components, checks and agent tools in a folder, with a catalog to browse."],
  ["Export", "H.264 or HEVC, loudness for social or broadcast, optional subtitles."],
];

type FeatureProps = {
  id?: string;
  title: string;
  line: string;
  flip?: boolean;
  size?: "narrow" | "wide";
  layout?: "stacked" | "broad";
  children: ReactNode;
};

/** A headline and one line beside a picture from the app; flip puts the picture on the left. On desktop, stacked puts the headline above a full-width picture and broad gives the picture the larger share. */
function Feature({ id, title, line, flip, size, layout, children }: FeatureProps) {
  return (
    <section id={id}>
      <div className={["wrap feature", flip && "flip", layout].filter(Boolean).join(" ")}>
        <div data-reveal="" className="copy">
          <h2>{title}</h2>
          <p className="sub">{line}</p>
        </div>
        <figure className={size ? `panel ${size}` : "panel"} data-reveal="">
          {children}
        </figure>
      </div>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: SITE_NAME,
          description: DESCRIPTION,
          url: `${SITE_URL}/`,
          applicationCategory: "MultimediaApplication",
          operatingSystem: "macOS",
          downloadUrl: DOWNLOAD_URL,
          codeRepository: REPO_URL,
          license: `${REPO_URL}/blob/main/LICENSE`,
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        }}
      />
      <SiteHeader />

      <main id="main">
        <div className="hero">
          <HeroFx />
          <div className="wrap">
            <div className="hero-copy">
              <h1>
                <Words text="Edit videos by talking to an agent" />
              </h1>
              <p className="lede">
                Uncut is a video editor for the Mac with an agent built in. It runs your installed{" "}
                <span className="who">
                  <ClaudeMark />
                  Claude{"\u00a0"}Code
                </span>{" "}
                or{" "}
                <span className="who">
                  <CodexMark />
                  Codex
                </span>
                . The agent plans the cut, edits a real timeline while you watch, and hands every change back to you to keep or undo.
              </p>
              <DownloadButtons />
              <p className="req">
                For Apple silicon Macs. Free and open source. Needs ffmpeg from Homebrew. Uses code of FFmpeg licensed under the LGPLv2.1,{" "}
                <a href={`${REPO_URL}/blob/main/THIRD_PARTY_NOTICES`}>see the third-party notices</a>.
              </p>
            </div>
          </div>
          <div className="wrap wide">
            <ZoomShot
              className="shot"
              src="/assets/img/editor.webp"
              width={3200}
              height={1904}
              fetchPriority="high"
              alt="The Uncut editor cutting a travel film from drone footage: a media library of Croatian coast clips, the title Day four over a coastal road at golden hour in the preview, a timeline with a kicker, titles, a graphic, six clips with transitions and music, and the agent panel with its brief, an approved storyboard and a passed review."
            />
          </div>
        </div>

        <section id="film">
          <div className="wrap film">
            <div data-reveal="" className="copy">
              <h2>The launch film, made in Uncut</h2>
              <p className="sub">28 seconds, cut by the agent in Uncut itself. Turn the sound on in the player.</p>
            </div>
            <div data-reveal="">
              <LaunchFilm />
            </div>
          </div>
        </section>

        <Feature
          id="features"
          layout="stacked"
          title="It edits the timeline while you watch"
          line="Ask for a cut. A brief and a storyboard come first, then the edit lands on your timeline."
        >
          <AgentPlayback />
        </Feature>

        <Feature
          flip
          size="wide"
          layout="broad"
          title="A critic reviews the cut"
          line="A separate agent that never saw the chat scores rendered frames and sends weak edits back."
        >
          <CriticPlayback />
        </Feature>

        <section>
          <div className="wrap">
            <div data-reveal="" className="copy center">
              <h2>A real editor underneath</h2>
              <p className="sub">Each agent turn undoes in one step. Everything it does, you can do by hand.</p>
            </div>
            <TimelineShot>
              <img
                className="timeline-shot"
                src="/assets/img/timeline-v2.webp"
                width={2080}
                height={620}
                loading="lazy"
                alt="The timeline of the Croatia film: a kicker track with Croatia, a text track with Day four and Golden hour on the coast, a Title accent graphic, the main track with drone shots joined by transitions, and the Evening theme music bed."
              />
            </TimelineShot>
          </div>
        </section>

        <Feature size="narrow" title="Cut the talk by its words" line="Transcription runs on your Mac. Fillers and long pauses go in one click.">
          <TranscriptWords>
            <img
              src="/assets/img/transcript.webp"
              width={520}
              height={1040}
              loading="lazy"
              alt="The transcript panel with buttons to remove filler words and pauses over 0.5 s, to make captions from the transcript, and the transcribed talk below with its timecodes."
            />
          </TranscriptWords>
        </Feature>

        <Feature
          flip
          size="narrow"
          title="Titles, lower thirds and captions"
          line="Animated titles and end cards. Captions burn in or play word by word, with SRT and WebVTT in and out."
        >
          <img
            src="/assets/img/text.webp"
            width={520}
            height={1040}
            loading="lazy"
            alt="Text presets: title, text, lower third, big title, kicker and title, highlight word, caption, stroked title, outline and boxed label."
          />
        </Feature>

        <section>
          <div className="wrap">
            <div data-reveal="" className="copy center">
              <h2>Record straight into the project</h2>
              <p className="sub">Your screen, camera and mic, or iOS simulators and Android emulators.</p>
            </div>
            <figure className="panel capture" data-reveal="">
              <img
                src="/assets/img/capture.webp"
                width={520}
                height={490}
                loading="lazy"
                alt="The capture panel recording an iPhone 16 iOS simulator, with a Record button, the flow, maximum length, orientation, the app to open, and options to show touches and cut still parts."
              />
            </figure>
          </div>
        </section>

        <section>
          <div className="wrap more">
            <h2 data-reveal="" className="copy">
              The rest of the edit
            </h2>
            <dl className="more-list">
              {MORE.map(([term, line]) => (
                <div key={term} data-reveal="">
                  <dt>{term}</dt>
                  <dd>{line}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section>
          <div className="wrap">
            <div data-reveal="" className="copy center">
              <h2>No Uncut account, no Uncut quotas</h2>
              <p className="sub">
                Your files stay on your Mac, and the agent runs on your own sign-in. Frames, transcripts and prompts go to its provider.{" "}
                <a href="/privacy/">Privacy notice</a>
              </p>
            </div>
          </div>
        </section>

        <section className="cta">
          <div className="wrap copy" data-reveal="">
            <h2>Start your next cut</h2>
            <p className="sub">Install Claude Code or Codex, add ffmpeg from Homebrew, then tell Uncut what to make.</p>
            <DownloadButtons />
            <p className="req">
              For Apple silicon Macs. Uses code of FFmpeg licensed under the LGPLv2.1,{" "}
              <a href={`${REPO_URL}/blob/main/THIRD_PARTY_NOTICES`}>see the third-party notices</a>.
            </p>
          </div>
        </section>
      </main>

      <SiteFooter />
      <ScrollReveal />
    </>
  );
}
