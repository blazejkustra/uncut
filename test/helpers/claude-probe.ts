// Drives the real claude as Uncut's session does (stream-json in and out, --permission-prompt-tool
// stdio): one message, every can_use_tool request answered by `answer` and recorded. For the
// skills security tests (claude-skills-real.test.ts).
import { spawn } from "node:child_process";

export interface ProbeRun {
  /** The tools claude asked about, in order. */
  readonly asked: Array<string>;
  /** The tools the model called. */
  readonly used: Array<string>;
}

export function probeClaude(o: {
  readonly bin: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly prompt: string;
  readonly answer: (tool: string) => boolean;
  readonly timeoutMs: number;
}): Promise<ProbeRun> {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-prompt-tool", "stdio", ...o.args];
  const child = spawn(o.bin, args, { cwd: o.cwd, stdio: ["pipe", "pipe", "pipe"] });
  const asked: Array<string> = [];
  const used: Array<string> = [];
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  send({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
  send({ type: "user", message: { role: "user", content: [{ type: "text", text: o.prompt }] } });
  const onLine = (line: string) => {
    let m: {
      type?: string;
      request_id?: string;
      request?: { subtype?: string; tool_name?: string; input?: unknown };
      message?: { content?: Array<{ type: string; name?: string }> };
    };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.type === "assistant") for (const c of m.message?.content ?? []) if (c.type === "tool_use" && c.name) used.push(c.name);
    if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
      const tool = m.request.tool_name ?? "";
      asked.push(tool);
      const response = o.answer(tool) ? { behavior: "allow", updatedInput: m.request.input } : { behavior: "deny", message: "Not done: refused by the test." };
      send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
    }
    if (m.type === "result") child.stdin.end();
  };
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude didn't finish"));
    }, o.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        onLine(buf.slice(0, i).trim());
        buf = buf.slice(i + 1);
      }
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve({ asked, used });
    });
  });
}
