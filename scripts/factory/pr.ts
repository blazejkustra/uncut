import { Escalation } from "./errors.ts";
import { plainLine } from "./text.ts";

const MIN_PROSE_CHARS = 100;
const MAX_PROSE_CHARS = 400;
const SECTIONS = ["## Problem", "## Approach", "## Tests", "## Screenshots"];

const ATTRIBUTION: ReadonlyArray<RegExp> = [
  /co-authored-by:.*(claude|anthropic)/i,
  /claude-session:/i,
  /claude\.ai\/code/i,
  /generated (with|by)\W+(\[)?claude/i,
  /noreply@anthropic\.com/i,
];

export function findAttribution(text: string) {
  return ATTRIBUTION.some((pattern) => pattern.test(text));
}

export function assertNoAttribution(stage: string, text: string) {
  if (findAttribution(text)) throw new Escalation(stage, "attribution text was found in what would be published");
}

export interface PrEvidence {
  readonly issue: number;
  readonly title: string;
  readonly summary: string;
  readonly gates: ReadonlyArray<string>;
  readonly fixRounds: number;
  readonly verify: string;
  readonly reviewer: string;
}

function testBullets(evidence: PrEvidence) {
  const passedGates = evidence.gates.map((gate) => `- \`pnpm ${gate}\` passed on the final commit`);
  return [
    ...passedGates,
    `- mac-verify: ${evidence.verify}`,
    `- Reviewer in a fresh context: ${evidence.reviewer}`,
    `- Fix rounds used: ${evidence.fixRounds}`,
    "- Not run: the packaged-app tests, and nothing was checked on screen",
  ];
}

export function buildPrBody(evidence: PrEvidence) {
  const problem = `Issue #${evidence.issue} asks for: ${plainLine(evidence.title, 110)}.`;
  const approach = `The factory planned, implemented and reviewed this in isolated agent steps. ${plainLine(evidence.summary, 140)}`;
  return ["## Problem", problem, "", "## Approach", approach, "", "## Tests", ...testBullets(evidence), "", "## Screenshots", ""].join("\n");
}

function sectionText(body: string, heading: string, nextHeading: string) {
  return body.slice(body.indexOf(heading) + heading.length, body.indexOf(nextHeading)).trim();
}

export function prBodyProblem(body: string) {
  const headings = body.split("\n").filter((line) => line.startsWith("#"));
  if (headings.join("|") !== SECTIONS.join("|")) return "sections differ from the required four";
  const proseLength = sectionText(body, "## Problem", "## Approach").length + sectionText(body, "## Approach", "## Tests").length;
  if (proseLength < MIN_PROSE_CHARS || proseLength > MAX_PROSE_CHARS) return `Problem and Approach run ${proseLength} characters`;
  return undefined;
}
