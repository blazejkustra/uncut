// Issue #63 (D234): the labs' marks next to each model in the Generate tab. Claude and OpenAI are
// the composer's (from t3code, MIT); Google, ByteDance and ElevenLabs are Simple Icons' paths
// (simple-icons 16.35.0, CC0 1.0); xAI's is from LobeHub's lobe-icons (@lobehub/icons-static-svg
// 1.95.1, MIT, Copyright (c) 2023 LobeHub). Higgsfield has no mark under a permissive licence, so
// it gets a monogram. See THIRD_PARTY_NOTICES. The marks are their owners' trademarks, shown only to
// say who makes a model; Uncut isn't made by or affiliated with any of them.
import type { ReactElement, SVGProps } from "react";

import { ClaudeMark, OpenAIMark } from "../composer/providerMarks.tsx";
import type { Brand } from "./catalog.ts";

type Mark = (props: SVGProps<SVGSVGElement>) => ReactElement;

/** Google's G (Simple Icons "google"). */
const GoogleMark: Mark = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor">
    <path d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
  </svg>
);

/** ByteDance's bars (Simple Icons "bytedance"). */
const ByteDanceMark: Mark = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.8772 1.4685L24 2.5326v18.9426l-4.1228 1.0563V1.4685zm-13.3481 9.428l4.115 1.0641v8.9786l-4.115 1.0642v-11.107zM0 2.572l4.115 1.0642v16.7354L0 21.428V2.572zm17.4553 5.6205v11.107l-4.1228-1.0642V9.2568l4.1228-1.0642z" />
  </svg>
);

/** ElevenLabs' two bars (Simple Icons "elevenlabs"). */
const ElevenLabsMark: Mark = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor">
    <path d="M4.6035 0v24h4.9317V0zm9.8613 0v24h4.9317V0z" />
  </svg>
);

/** xAI's mark (lobe-icons "xai"). */
const XAIMark: Mark = (props) => (
  <svg {...props} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd">
    <path d="M6.469 8.776L16.512 23h-4.464L2.005 8.776H6.47zm-.004 7.9l2.233 3.164L6.467 23H2l4.465-6.324zM22 2.582V23h-3.659V7.764L22 2.582zM22 1l-9.952 14.095-2.233-3.163L17.533 1H22z" />
  </svg>
);

const MARKS: Partial<Record<Brand, Mark>> = { claude: ClaudeMark, openai: OpenAIMark, google: GoogleMark, bytedance: ByteDanceMark, elevenlabs: ElevenLabsMark, xai: XAIMark };

/** A model's lab mark in a small tile; a monogram where there's no mark to use. */
export function LabMark({ brand, lab }: { brand: Brand; lab: string }) {
  const Mark = MARKS[brand];
  return (
    <span className={`gen-mark ${brand}`} data-testid="generator-mark" data-brand={brand} aria-hidden>
      {Mark ? <Mark className="gen-mark-logo" focusable="false" /> : <span className="gen-mark-letter">{lab.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}
