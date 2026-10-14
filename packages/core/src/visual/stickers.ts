// Stickers (F22, D165): a bundled set the Elements tab searches, no network. Emoji are drawn by the
// system's colour emoji font (a name and keywords each, our own list); the drawn stickers are SVG
// we made for Uncut (own work, CC0), kept here so the preview and the export draw the same markup.
// A sticker item is a component.sticker with props.emoji or props.art (an id below).

export interface StickerEntry {
  /** "emoji:🔥" or "art:burst". */
  readonly key: string;
  readonly name: string;
  readonly keywords: ReadonlyArray<string>;
  readonly emoji?: string;
  readonly art?: string;
}

/** [emoji, name, keywords]: a small everyday set for video overlays. */
const EMOJI: ReadonlyArray<readonly [string, string, string]> = [
  ["🔥", "fire", "hot lit flame trending"],
  ["😂", "laughing", "lol funny joy tears haha"],
  ["🤣", "rolling laughing", "lol funny rofl haha"],
  ["😍", "heart eyes", "love crush adore"],
  ["🥰", "smiling hearts", "love cute adore"],
  ["😎", "cool", "sunglasses chill smooth"],
  ["🤔", "thinking", "hmm wonder question"],
  ["🤯", "mind blown", "wow shocked explode amazing"],
  ["😱", "screaming", "shock scared omg wow"],
  ["😮", "surprised", "wow omg open mouth"],
  ["😭", "crying", "sad tears sob"],
  ["😢", "sad", "tear cry unhappy"],
  ["😅", "sweat smile", "phew nervous relief"],
  ["😊", "smile", "happy blush glad"],
  ["😀", "grin", "happy smile face"],
  ["😉", "wink", "flirt joke"],
  ["🙃", "upside down", "silly irony"],
  ["😴", "sleeping", "tired zzz bored"],
  ["🥳", "party face", "celebrate birthday hooray"],
  ["🤩", "star struck", "wow amazing excited"],
  ["😡", "angry", "mad rage furious"],
  ["🤬", "cursing", "angry swear mad"],
  ["🤫", "shush", "quiet secret silence"],
  ["🫡", "salute", "respect yes sir"],
  ["🥲", "smile tear", "bittersweet touched"],
  ["😬", "grimace", "awkward oops yikes"],
  ["🙄", "eye roll", "whatever annoyed bored"],
  ["🤡", "clown", "silly joke fool"],
  ["💀", "skull", "dead lol dying"],
  ["👻", "ghost", "boo spooky halloween"],
  ["👽", "alien", "ufo space"],
  ["🤖", "robot", "ai bot machine tech"],
  ["💩", "poop", "funny bad"],
  ["👍", "thumbs up", "like yes ok good approve"],
  ["👎", "thumbs down", "dislike no bad"],
  ["👏", "clap", "applause bravo congrats"],
  ["🙌", "raised hands", "hooray celebrate praise"],
  ["🙏", "pray", "please thanks hope"],
  ["💪", "muscle", "strong power gym flex"],
  ["👀", "eyes", "look watch see"],
  ["👋", "wave", "hello hi bye"],
  ["👉", "point right", "this here next"],
  ["👈", "point left", "this here back"],
  ["👆", "point up", "above this"],
  ["👇", "point down", "below this subscribe"],
  ["✌️", "peace", "victory two"],
  ["🤞", "fingers crossed", "luck hope"],
  ["🤝", "handshake", "deal agree partner"],
  ["✍️", "writing", "note write"],
  ["🧠", "brain", "smart think idea"],
  ["❤️", "red heart", "love like"],
  ["💔", "broken heart", "sad breakup"],
  ["💖", "sparkling heart", "love cute"],
  ["💯", "hundred", "perfect score 100 keep it real"],
  ["✨", "sparkles", "magic shine new clean"],
  ["⭐", "star", "favourite favorite rating"],
  ["🌟", "glowing star", "shine special"],
  ["⚡", "lightning", "fast power energy zap"],
  ["💥", "boom", "explosion bang collision"],
  ["💫", "dizzy", "stars magic"],
  ["💬", "speech bubble", "chat talk comment"],
  ["💭", "thought bubble", "think idea"],
  ["💡", "light bulb", "idea tip smart"],
  ["❓", "question", "what ask help"],
  ["❗", "exclamation", "important alert warning"],
  ["⚠️", "warning", "caution alert danger"],
  ["✅", "check", "done yes correct tick ok"],
  ["❌", "cross", "no wrong cancel x"],
  ["🚫", "prohibited", "no forbidden stop"],
  ["🛑", "stop", "halt sign"],
  ["🎉", "party popper", "celebrate congrats tada hooray"],
  ["🎊", "confetti", "celebrate party"],
  ["🎁", "gift", "present giveaway"],
  ["🏆", "trophy", "win winner champion award"],
  ["🥇", "gold medal", "first winner"],
  ["🎯", "target", "goal bullseye aim"],
  ["🚀", "rocket", "launch fast ship space"],
  ["📈", "chart up", "growth increase stonks"],
  ["📉", "chart down", "decrease loss"],
  ["💰", "money bag", "cash rich dollar"],
  ["💸", "money flying", "spend cash"],
  ["💎", "gem", "diamond value"],
  ["⏰", "alarm clock", "time wake deadline"],
  ["⏳", "hourglass", "time wait loading"],
  ["📌", "pin", "pinned important"],
  ["📍", "location", "place map here"],
  ["🔔", "bell", "notification subscribe alert"],
  ["🔒", "lock", "secure private"],
  ["🔑", "key", "access unlock"],
  ["🛠️", "tools", "build fix repair"],
  ["⚙️", "gear", "settings config"],
  ["💻", "laptop", "computer code work"],
  ["📱", "phone", "mobile app"],
  ["⌨️", "keyboard", "type code"],
  ["🎥", "movie camera", "film video record"],
  ["📸", "camera flash", "photo picture"],
  ["🎬", "clapper", "action film scene cut"],
  ["🎤", "microphone", "sing talk podcast"],
  ["🎧", "headphones", "music listen audio"],
  ["🎵", "music note", "song melody"],
  ["🎮", "game", "controller play gaming"],
  ["📚", "books", "learn study read"],
  ["📝", "memo", "notes write list"],
  ["🔍", "magnifier", "search find zoom look"],
  ["🔗", "link", "chain url"],
  ["📦", "package", "box ship delivery"],
  ["🐛", "bug", "error issue insect"],
  ["☕", "coffee", "drink morning break"],
  ["🍕", "pizza", "food lunch"],
  ["🍔", "burger", "food lunch"],
  ["🍿", "popcorn", "movie watch snack"],
  ["🍻", "cheers", "beer drinks toast"],
  ["🎂", "cake", "birthday celebrate"],
  ["🌈", "rainbow", "pride colours colors"],
  ["☀️", "sun", "sunny summer weather"],
  ["🌙", "moon", "night sleep"],
  ["❄️", "snowflake", "cold winter"],
  ["🌊", "wave water", "ocean sea surf"],
  ["🌍", "earth", "world globe planet"],
  ["🌸", "blossom", "flower spring"],
  ["🌵", "cactus", "desert plant"],
  ["🐶", "dog", "puppy pet"],
  ["🐱", "cat", "kitten pet"],
  ["🦄", "unicorn", "magic rare"],
  ["🐐", "goat", "greatest best"],
  ["🦋", "butterfly", "change pretty"],
  ["✈️", "plane", "travel flight trip"],
  ["🚗", "car", "drive road"],
  ["🏁", "finish flag", "race end done"],
  ["➡️", "arrow right", "next forward"],
  ["⬅️", "arrow left", "back previous"],
  ["⬆️", "arrow up", "up above"],
  ["⬇️", "arrow down", "down below"],
  ["🔄", "repeat", "refresh loop again"],
  ["🆕", "new", "fresh latest"],
  ["🆒", "cool button", "cool"],
  ["🔴", "red circle", "record live dot"],
  ["🟢", "green circle", "go online dot"],
];

/** Our drawn stickers: id, name, keywords, and the SVG (a 200 × 200 view box, own work, CC0). */
const ART: ReadonlyArray<readonly [string, string, string, string]> = [
  [
    "burst",
    "Wow burst",
    "wow boom comic star explosion",
    `<polygon points="100,6 119,52 168,30 152,80 196,100 152,120 168,170 119,148 100,194 81,148 32,170 48,120 4,100 48,80 32,30 81,52" fill="#FFD23F" stroke="#111111" stroke-width="6" stroke-linejoin="round"/><text x="100" y="116" text-anchor="middle" font-family="'DM Sans',sans-serif" font-weight="900" font-size="46" fill="#111111">WOW</text>`,
  ],
  ["arrow", "Arrow", "point pointer this look here curved", `<path d="M40 160 C 50 90, 100 60, 150 62" fill="none" stroke="#111111" stroke-width="22" stroke-linecap="round"/><path d="M40 160 C 50 90, 100 60, 150 62" fill="none" stroke="#FFFFFF" stroke-width="12" stroke-linecap="round"/><polygon points="176,62 136,36 140,90" fill="#FFFFFF" stroke="#111111" stroke-width="6" stroke-linejoin="round"/>`],
  ["heart", "Heart", "love like favourite favorite", `<path d="M100 176 L 30 104 C 4 76, 20 28, 60 28 C 80 28, 94 42, 100 54 C 106 42, 120 28, 140 28 C 180 28, 196 76, 170 104 Z" fill="#FF3B5C" stroke="#111111" stroke-width="6" stroke-linejoin="round"/><ellipse cx="62" cy="64" rx="14" ry="9" fill="#FFFFFF" opacity="0.55" transform="rotate(-30 62 64)"/>`],
  ["bubble", "Speech bubble", "talk chat say comment quote", `<path d="M30 40 H170 A18 18 0 0 1 188 58 V122 A18 18 0 0 1 170 140 H86 L52 172 L58 140 H30 A18 18 0 0 1 12 122 V58 A18 18 0 0 1 30 40 Z" fill="#FFFFFF" stroke="#111111" stroke-width="6" stroke-linejoin="round"/><circle cx="64" cy="90" r="10" fill="#111111"/><circle cx="100" cy="90" r="10" fill="#111111"/><circle cx="136" cy="90" r="10" fill="#111111"/>`],
  ["new", "New badge", "new label tag fresh latest", `<rect x="14" y="58" width="172" height="84" rx="22" fill="#FF3B5C" stroke="#111111" stroke-width="6" transform="rotate(-8 100 100)"/><text x="100" y="118" text-anchor="middle" font-family="'DM Sans',sans-serif" font-weight="900" font-size="54" fill="#FFFFFF" transform="rotate(-8 100 100)">NEW</text>`],
  ["sparkle", "Sparkle", "shine magic star twinkle clean", `<path d="M100 10 C 108 70, 130 92, 190 100 C 130 108, 108 130, 100 190 C 92 130, 70 108, 10 100 C 70 92, 92 70, 100 10 Z" fill="#FFE14D" stroke="#111111" stroke-width="6" stroke-linejoin="round"/><path d="M160 22 C 163 38, 168 43, 184 46 C 168 49, 163 54, 160 70 C 157 54, 152 49, 136 46 C 152 43, 157 38, 160 22 Z" fill="#FFFFFF" stroke="#111111" stroke-width="4" stroke-linejoin="round"/>`],
  ["check", "Check", "done yes correct tick ok", `<circle cx="100" cy="100" r="84" fill="#3DDC84" stroke="#111111" stroke-width="6"/><path d="M58 102 L 88 132 L 144 72" fill="none" stroke="#FFFFFF" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>`],
];

export const STICKER_ART: Readonly<Record<string, { readonly name: string; readonly svg: string }>> = Object.fromEntries(ART.map(([id, name, , body]) => [id, { name, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%">${body}</svg>` }]));
export const STICKER_ART_IDS = ART.map(([id]) => id);

/** Every sticker: the drawn ones first, then the emoji. */
export const STICKERS: ReadonlyArray<StickerEntry> = [
  ...ART.map(([id, name, keywords]) => ({ key: `art:${id}`, name, keywords: keywords.split(" "), art: id })),
  ...EMOJI.map(([emoji, name, keywords]) => ({ key: `emoji:${emoji}`, name, keywords: keywords.split(" "), emoji })),
];

/**
 * Stickers matching a search: every word of the query starts a word of the name or a keyword (or
 * is the emoji itself); ranked name matches first. An empty query lists them all.
 */
export function searchStickers(query: string): ReadonlyArray<StickerEntry> {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return STICKERS;
  const scored: Array<{ s: StickerEntry; score: number; i: number }> = [];
  STICKERS.forEach((s, i) => {
    const nameWords = s.name.toLowerCase().split(/\s+/);
    let score = 0;
    for (const t of terms) {
      if (s.emoji === t) score += 3;
      else if (nameWords.some((w) => w.startsWith(t))) score += 2;
      else if (s.keywords.some((k) => k.startsWith(t))) score += 1;
      else return;
    }
    scored.push({ s, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((x) => x.s);
}

/** The props a sticker from the set gets (component.sticker): the emoji, or the drawn art. */
export const stickerProps = (entry: StickerEntry): Record<string, unknown> => (entry.art ? { art: entry.art, pop: true, tilt: 0 } : { emoji: entry.emoji!, pop: true, tilt: -8 });
