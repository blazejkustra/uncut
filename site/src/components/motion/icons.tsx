// Icons from lucide (ISC, listed in THIRD_PARTY_NOTICES), the set the app itself uses.
import type { ReactNode } from "react";

function Lucide({ children, className }: { children: ReactNode; className?: string | undefined }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

type IconProps = { className?: string | undefined };

export const Images = (p: IconProps) => (
  <Lucide {...p}>
    <path d="M18 22H4a2 2 0 0 1-2-2V6" />
    <path d="m22 13-1.296-1.296a2.41 2.41 0 0 0-3.408 0L11 18" />
    <circle cx="12" cy="8" r="2" />
    <rect width="16" height="16" x="6" y="2" rx="2" />
  </Lucide>
);
export const Check = (p: IconProps) => (
  <Lucide {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Lucide>
);
export const ClipboardList = (p: IconProps) => (
  <Lucide {...p}>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
    <path d="M12 11h4" />
    <path d="M12 16h4" />
    <path d="M8 11h.01" />
    <path d="M8 16h.01" />
  </Lucide>
);
export const Clapperboard = (p: IconProps) => (
  <Lucide {...p}>
    <path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z" />
    <path d="m6.2 5.3 3.1 3.9" />
    <path d="m12.4 3.4 3.1 4" />
    <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </Lucide>
);
export const PencilLine = (p: IconProps) => (
  <Lucide {...p}>
    <path d="M12 20h9" />
    <path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z" />
    <path d="m15 5 3 3" />
  </Lucide>
);
export const Gauge = (p: IconProps) => (
  <Lucide {...p}>
    <path d="m12 14 4-4" />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </Lucide>
);
export const LoaderCircle = (p: IconProps) => (
  <Lucide {...p}>
    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
  </Lucide>
);
export const ChevronRight = (p: IconProps) => (
  <Lucide {...p}>
    <path d="m9 18 6-6-6-6" />
  </Lucide>
);
export const ChevronDown = (p: IconProps) => (
  <Lucide {...p}>
    <path d="m6 9 6 6 6-6" />
  </Lucide>
);
export const Undo = (p: IconProps) => (
  <Lucide {...p}>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
  </Lucide>
);
export const Pencil = (p: IconProps) => (
  <Lucide {...p}>
    <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <path d="m15 5 4 4" />
  </Lucide>
);
export const Paperclip = (p: IconProps) => (
  <Lucide {...p}>
    <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </Lucide>
);
export const AtSign = (p: IconProps) => (
  <Lucide {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
  </Lucide>
);
export const ArrowUp = (p: IconProps) => (
  <Lucide {...p}>
    <path d="m5 12 7-7 7 7" />
    <path d="M12 19V5" />
  </Lucide>
);
export const Square = (p: IconProps) => (
  <Lucide {...p}>
    <rect width="18" height="18" x="3" y="3" rx="2" fill="currentColor" />
  </Lucide>
);
export const MousePointer = (p: IconProps) => (
  <Lucide {...p}>
    <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
  </Lucide>
);
export const Sparkles = (p: IconProps) => (
  <Lucide {...p}>
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
    <path d="M20 3v4" />
    <path d="M22 5h-4" />
    <path d="M4 17v2" />
    <path d="M5 18H3" />
  </Lucide>
);
