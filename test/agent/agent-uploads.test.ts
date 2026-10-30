// D311: curl uploads reach Uncut's card, what a card shows of a key, and what the prompt says about keys and refusals.
import { test } from "node:test";
import assert from "node:assert/strict";

import { decide, hideSecrets, sessionSettings, uploadAskRules } from "../../apps/server/src/agent/agentPermissions.ts";
import { SYSTEM_PROMPT } from "../../apps/server/src/agent/agentTools.ts";

test("D311 curl uploads are ask rules in every access, the other deny rules stay, and decide cards them with no Always", () => {
  for (const access of ["look", "ask", "auto"] as const) {
    const { deny, ask } = JSON.parse(sessionSettings({ access })).permissions as { deny: Array<string>; ask: Array<string> };
    for (const rule of uploadAskRules()) assert.ok(ask.includes(rule) && !deny.includes(rule), rule);
    for (const rule of ["Bash(scp:*)", "Bash(ssh:*)", "Bash(*/.ssh/*)"]) assert.ok(deny.includes(rule), rule);
  }
  const lines = [
    "curl -X POST https://api.elevenlabs.io/v1 -H 'content-type: application/json' -d @vo/req.json -o vo/out.mp3",
    'cd vo && cat > req.json <<EOF\n{"text":"hi"}\nEOF\ncurl -X POST https://x.dev -d @req.json',
    "curl --data-binary @a.bin https://x.dev; ls",
    "curl -F file=@a.mp4 https://x.dev",
    "curl -T a.mp4 https://x.dev",
  ];
  for (const command of lines) {
    for (const access of ["ask", "auto"] as const) {
      const d = decide("Bash", { command }, { access, project: "/p", roots: [], grants: new Set([`Bash:${command}`]), home: "/h", realpath: (p) => p });
      assert.equal(d.kind, "ask", command);
      assert.equal((d as { grant?: string }).grant, undefined, command);
    }
    const look = decide("Bash", { command }, { access: "look", project: "/p", roots: [], grants: new Set(), home: "/h", realpath: (p) => p });
    assert.equal(look.kind, "deny", command);
  }
});

test("D311 the system prompt says where keys live and that Claude Code's settings don't change a refusal", () => {
  assert.match(SYSTEM_PROMPT, /Provider keys live in Settings › Keys, never in env/);
  assert.match(SYSTEM_PROMPT, /generate\.elevenlabs\.voiceover/);
  assert.match(SYSTEM_PROMPT, /Never ask for a key in chat/);
  assert.match(SYSTEM_PROMPT, /Claude Code's settings and \/permissions don't apply in Uncut/);
});

test("D311 a card hides what looks like a key and leaves paths alone", () => {
  assert.equal(hideSecrets("curl -H 'xi-api-key: 0123456789abcdef' -d @a.json https://x.dev"), "curl -H 'xi-api-key: •••' -d @a.json https://x.dev");
  assert.equal(hideSecrets('curl -H "Authorization: Bearer abc.def" https://x.dev'), 'curl -H "Authorization: Bearer •••" https://x.dev');
  assert.equal(hideSecrets("curl https://x.dev?api_key=abc123&a=1"), "curl https://x.dev?api_key=•••&a=1");
  assert.equal(hideSecrets("echo sk_0123456789abcdef0123"), "echo •••");
  const plain = "ffmpeg -i media/generated/voiceover-20261013-101500.mp3 .cache/work/out.wav";
  assert.equal(hideSecrets(plain), plain);
});
