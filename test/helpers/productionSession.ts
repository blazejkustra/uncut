// The bundled server on fake-claude's session for the agent production tests: a scripted plan per
// turn, the critic's scripted answers, and the logs of prompts, tool results and critic runs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect, startServer } from "./server.ts";

const FAKE = resolve("test/helpers/fake-claude.ts");
export type Content = Array<{ type: string; text?: string; mimeType?: string }>;

/** A bundled server on fake-claude's scripted session with a new project, its prompts, tool results and critic runs logged. */
export async function productionSession(base: string) {
  mkdirSync(join(base, "projects"), { recursive: true });
  const plan = join(base, "plan.json");
  const log = join(base, "prompts.jsonl");
  const results = join(base, "results.jsonl");
  writeFileSync(log, "");
  writeFileSync(results, "");
  const data = join(base, "data");
  // D195: the critic's scripted answers and what each critic process got.
  const critic = join(base, "critic.json");
  const criticLog = join(base, "critic.jsonl");
  writeFileSync(critic, "[]");
  writeFileSync(criticLog, "");
  const server = await startServer({
    env: {
      UNCUT_DATA_DIR: data,
      UNCUT_CLAUDE: FAKE,
      FAKE_PLAN: plan,
      FAKE_PROMPT_LOG: log,
      FAKE_RESULT_LOG: results,
      FAKE_CRITIC: critic,
      FAKE_CRITIC_LOG: criticLog,
      UNCUT_APPROVAL_MS: "8000",
      UNCUT_ANALYZE_WAIT_MS: "20000",
      OPENAI_API_KEY: "sk-openai-test",
    },
  });
  const client = await connect(server.ready.port, server.ready.token);
  const agent = client.subscribe("agent.subscribe");
  const snap = await client.ok("project.create", { parentDir: join(base, "projects"), name: "Promo" });
  await agent.until((s) => s?.dir === snap.dir);
  const turns: Array<unknown> = [];
  const latest = () => agent.values.at(-1);
  const turn = (id: string) => latest()?.turns.find((t: { id: string }) => t.id === id);
  let seen = 0;
  const self = {
    base,
    data,
    client,
    agent,
    latest,
    dir: snap.dir as string,
    /** The critic's answers, one per critic run from now on. */
    critic: (answers: Array<unknown>) => (writeFileSync(critic, JSON.stringify(answers)), rmSync(`${critic}.turn`, { force: true })),
    criticRuns: (): Array<{ critic: true; text: string; images: number; resume: string | null; args: Array<string>; env: Array<string>; cwd: string }> =>
      readFileSync(criticLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    prompts: (): Array<{ prompt: string; system: string }> =>
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((r) => !r.refused),
    /** Tool results since the last call. */
    results: (): Array<{ tool: string; result: { isError?: boolean; content: Content } }> => {
      const all = readFileSync(results, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const out = all.slice(seen);
      seen = all.length;
      return out;
    },
    start: async (prompt: string, steps: Array<unknown>, extra: Record<string, unknown> = {}) => {
      turns.push(steps);
      writeFileSync(plan, JSON.stringify(turns));
      const { turnId } = await client.ok("agent.send", { prompt, ...extra });
      return turnId as string;
    },
    // A long scripted turn (the critic test: 21 tool calls, contact sheets, frames and three critic
    // runs) takes well over a minute on a 3-vCPU CI runner with the rest of the suite running (#88).
    done: async (id: string) => {
      await agent.until(() => turn(id) && turn(id).status !== "running", 150000);
      return turn(id);
    },
    card: async (id: string) => (await agent.until((v) => v?.approval?.turnId === id, 15000), latest().approval),
    ask: async (prompt: string, steps: Array<unknown>, extra: Record<string, unknown> = {}) => self.done(await self.start(prompt, steps, extra)),
    stop: async () => {
      client.close();
      await server.stop();
    },
  };
  return self;
}
