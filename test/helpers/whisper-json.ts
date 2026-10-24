// whisper-cli's full JSON (-ojf) as it writes it, for the fake whisper: segments with their timed
// tokens, special tokens ([_BEG_], [_TT_n]) included, token texts as raw UTF-8 bytes (a Polish
// letter can be split over two tokens). Shaped after a real run of whisper.cpp 1.9.5.
export type Token = readonly [text: string | Buffer, fromMs: number, toMs: number, p?: number];

const latin1 = (t: string | Buffer) => (typeof t === "string" ? Buffer.from(t, "utf8") : t).toString("latin1");
const stamp = (ms: number) => {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
};

/** The JSON file's bytes. */
export function whisperJson(segments: ReadonlyArray<ReadonlyArray<Token>>, language = "en"): Buffer {
  let id = 50363;
  const transcription = segments.map((tokens) => {
    const from = tokens[0]?.[1] ?? 0;
    const to = tokens.at(-1)?.[2] ?? from;
    const all: Array<Token> = [["[_BEG_]", from, from, 0.99], ...tokens, [`[_TT_${Math.round(to / 20)}]`, to, to, 0.05]];
    return {
      timestamps: { from: stamp(from), to: stamp(to) },
      offsets: { from, to },
      text: tokens.map((t) => latin1(t[0])).join(""),
      tokens: all.map(([text, a, b, p]) => ({
        text: latin1(text),
        timestamps: { from: stamp(a), to: stamp(b) },
        offsets: { from: a, to: b },
        id: id++,
        p: p ?? 0.9,
        t_dtw: -1,
      })),
    };
  });
  const doc = {
    systeminfo: "WHISPER : COREML = 0 | MTL : EMBED_LIBRARY = 1 | CPU : NEON = 1 |",
    model: { type: "tiny", multilingual: false, vocab: 51864, mels: 80, ftype: 1 },
    params: { model: "models/ggml-tiny.en.bin", language, translate: false },
    result: { language },
    transcription,
  };
  return Buffer.from(JSON.stringify(doc, null, "\t"), "latin1");
}

/** "Hello world, this is a test. Um, the quick brown fox jumps over the lazy dog." as tiny.en heard macOS `say` speak it. */
export const SAY_TOKENS: ReadonlyArray<ReadonlyArray<Token>> = [
  [
    [" Hello", 50, 460, 0.9],
    [" world", 460, 650, 0.44],
    [",", 1120, 1120, 0.28],
    [" this", 1130, 1430, 0.95],
    [" is", 1430, 1580, 0.99],
    [" a", 1580, 1650, 0.99],
    [" test", 1650, 1920, 0.98],
    [".", 2220, 2220, 0.7],
  ],
  [
    [" Um", 2270, 2360, 0.53],
    [",", 2360, 2500, 0.89],
    [" the", 2500, 2710, 0.95],
    [" quick", 2710, 2870, 0.84],
    [" brown", 3340, 3410, 0.92],
    [" fox", 3410, 3620, 0.93],
    [" jumps", 3620, 3940, 0.99],
    [" over", 3990, 4150, 0.99],
    [" the", 4460, 4460, 0.99],
    [" lazy", 4480, 4740, 0.96],
    [" dog", 4740, 4790, 0.98],
    [".", 5060, 5240, 0.93],
  ],
];
