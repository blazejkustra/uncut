"use client";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { usePlayback } from "./usePlayback.ts";

const IMAGE_WIDTH = 520;
const IMAGE_HEIGHT = 1040;
const LINE_REACH = 19;
const SEGMENT_PAUSE_MS = 420;
const HOLD_MS = 1600;

type Line = { y: number; words: ReadonlyArray<readonly [number, number]>; endsSegment?: boolean };

const LINES: ReadonlyArray<Line> = [
  { y: 562, words: [[35, 144], [159, 214], [227, 249], [262, 299], [313, 404], [419, 461]] },
  { y: 609, words: [[34, 112], [126, 158], [171, 277], [292, 333], [348, 415]] },
  { y: 656, words: [[36, 115]], endsSegment: true },
  { y: 767, words: [[35, 105], [118, 150], [164, 199], [214, 298], [313, 333], [346, 407]] },
  { y: 814, words: [[34, 97], [111, 133], [146, 183], [197, 259], [274, 366], [380, 429]] },
  { y: 861, words: [[34, 88], [103, 193]], endsSegment: true },
  { y: 973, words: [[35, 78], [92, 137], [151, 200], [214, 258], [272, 334], [349, 376], [390, 401], [416, 470]] },
  { y: 1019, words: [[36, 131], [145, 193], [207, 244], [258, 335], [351, 434]], endsSegment: true },
];

type Word = { x0: number; x1: number; y: number; wait: number };

function spokenMs(x0: number, x1: number): number {
  return 130 + (x1 - x0) * 2.2;
}

const WORDS: ReadonlyArray<Word> = LINES.flatMap((line) =>
  line.words.map(([x0, x1], i) => ({
    x0,
    x1,
    y: line.y,
    wait: spokenMs(x0, x1) + (line.endsSegment && i === line.words.length - 1 ? SEGMENT_PAUSE_MS : 0),
  })),
);

const WAITS: ReadonlyArray<number> = [...WORDS.map((w) => w.wait), HOLD_MS];

function wordBox(word: Word): CSSProperties {
  const pad = 4;
  return {
    left: `${((word.x0 - pad) / IMAGE_WIDTH) * 100}%`,
    width: `${((word.x1 - word.x0 + 2 * pad) / IMAGE_WIDTH) * 100}%`,
    top: `${((word.y - LINE_REACH) / IMAGE_HEIGHT) * 100}%`,
    height: `${((2 * LINE_REACH) / IMAGE_HEIGHT) * 100}%`,
  };
}

export default function TranscriptWords({ children }: { children: ReactNode }) {
  const { root, step } = usePlayback(WAITS);
  const [marksReady, setMarksReady] = useState(false);
  useEffect(() => setMarksReady(true), []);
  return (
    <div ref={root} className="tx-stage">
      {children}
      {marksReady && WORDS.map((word, i) => <span key={i} className="tx-mark" aria-hidden="true" data-on={i === step} style={wordBox(word)} />)}
    </div>
  );
}
