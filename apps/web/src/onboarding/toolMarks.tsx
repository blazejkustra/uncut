// D281: the tools' marks on the setup wizard's and Settings' rows, beside the agents' and the keyed
// providers' (D277), monochrome in the row's text colour.
// - FFmpeg: Simple Icons "ffmpeg" (simple-icons 16.33.0, CC0 1.0).
// - Argent: the mark from Argent's logo (software-mansion/argent, packages/docs/static/img/logo.svg
//   at 36aa14a, Apache-2.0), its outline drawn thicker so it reads at 20 px.
// - whisper.cpp has no logo of its own (none in ggml-org/whisper.cpp or Simple Icons, and OpenAI's
//   mark is for their Whisper model, not this program), so it gets Uncut's own neutral mark: a
//   speech bubble with a waveform. plugins/whisper-transcribe/icon.svg is the same drawing.
// See THIRD_PARTY_NOTICES. The marks are their owners' trademarks, shown only to name the program
// a row is about; Uncut isn't made by or affiliated with any of them.
import type { ReactElement, SVGProps } from "react";

type Mark = (props: SVGProps<SVGSVGElement>) => ReactElement;

/** FFmpeg's mark (Simple Icons "ffmpeg"). */
export const FFmpegMark: Mark = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor">
    <path d="M21.72 17.91V6.5l-.53-.49L9.05 18.52l-1.29-.06L24 1.53l-.33-.95-11.93 1-5.75 6.6v-.23l4.7-5.39-1.38-.77-9.11.77v2.85l1.91.46v.01l.19-.01-.56.66v10.6c.609-.126 1.22-.241 1.83-.36L14.12 5.22l.83-.04L0 21.44l9.67.82 1.35-.77 6.82-6.74v2.15l-5.72 5.57 11.26.95.35-.94v-3.16l-3.29-.18c.434-.403.858-.816 1.28-1.23z" />
  </svg>
);

/** Argent's mark (from its logo), outlined in the text colour. */
export const ArgentMark: Mark = (props) => (
  <svg {...props} viewBox="-1.5 -1.5 61 32" fill="none" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
    <path d="M3.10976 18.9198L1 28.75H19.7769L17.6671 18.9198H3.10976ZM3.10976 18.9198L12.0935 14.75M38.8894 28.75H20.3846L22.4638 18.9198H36.8102M38.8894 28.75L36.8102 18.9198M38.8894 28.75L57 20.0897L54.9208 10.2594M36.8102 18.9198L54.9208 10.2594M47.8462 10.2994L54.9208 10.2594M47.8462 10.2994L29.8077 18.9198M47.8462 10.2994L45.767 0.75M13.31 9.16289L11.2308 18.9198L29.8077 18.9198M13.31 9.16289H27.6563M13.31 9.16289L31.4206 0.75H45.767M29.8077 18.9198L27.6563 9.16289M27.6563 9.16289L45.767 0.75" />
  </svg>
);

/** Uncut's neutral mark for whisper.cpp (local speech to text): a speech bubble with a waveform. */
export const WhisperCppMark: Mark = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor">
    <path
      fillRule="evenodd"
      d="M5 3h14a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-7l-5 4v-4H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM6.6 9.2h1.6v2.6H6.6zM9.6 7.2h1.6v6.6H9.6zM12.6 8.2h1.6v4.6h-1.6zM15.6 9.5h1.6v2h-1.6z"
    />
  </svg>
);
