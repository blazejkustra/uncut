// How each tool call reads in a turn card: step labels and the now line (D182).
import { shortName } from "../agentFootage.ts";
import { shownPath, shellSegments } from "../agentPermissions.ts";

/** A tool call as a step in the turn card. `plugin`: the name of the plugin that owns the tool (D97). */
export function stepLabel(tool: string, input: unknown, plugin?: string, project?: string): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const builtin = builtinLabel(tool, args, project);
  if (builtin) return builtin;
  switch (tool) {
    case "project_read":
      return "Read the timeline";
    case "timeline_edit":
      if (args.dryRun === true)
        return typeof args.summary === "string" && args.summary.trim()
          ? `Planned ${args.summary.trim().replace(/^./, (c) => c.toLowerCase())}`
          : "Planned an edit";
      return typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "Edited the timeline";
    case "modules_list":
      return typeof args.kind === "string" ? `Checked the ${args.kind} modules` : "Checked the installed modules";
    case "render_frames": {
      const frames = Array.isArray(args.frames) ? args.frames.filter((f): f is number => typeof f === "number") : [];
      const list = frames.length > 4 ? `${frames.slice(0, 3).join(", ")} and ${frames.length - 3} more` : frames.join(", ");
      return frames.length === 1 ? `Looked at frame ${list}` : frames.length ? `Looked at frames ${list}` : "Looked at the edit";
    }
    case "media_import": {
      const paths = typeof args.path === "string" ? [args.path] : Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string") : [];
      if (paths.length === 1) return `Imported ${shortName(paths[0]!)}`;
      return paths.length ? `Imported ${paths.length} paths` : "Imported media";
    }
    case "contact_sheet": {
      const range = args.range && typeof args.range === "object" ? (args.range as { start?: unknown; end?: unknown }) : undefined;
      const span = range && typeof range.start === "number" && typeof range.end === "number" ? ` (frames ${range.start}–${range.end})` : "";
      if (args.at === "shots") return typeof args.media === "string" ? `Looked over the shots of ${args.media}${span}` : "Looked over the shots";
      return typeof args.media === "string" ? `Looked over ${args.media}${span}` : `Looked over the edit${span}`;
    }
    case "media_analyze": {
      const names = Array.isArray(args.analyzers) ? args.analyzers.filter((a): a is string => typeof a === "string") : [];
      const sound = new Set(["loudness", "silence"]);
      const picture = new Set(["video", "shots", "motion", "stability"]);
      const only = (n: string) => names.length > 0 && names.every((x) => x === n);
      const rhythm = new Set(["beats", "rhythm", "onsets", "tempo"]);
      const what =
        names.length > 0 && names.every((x) => x === "transcript" || x === "transcription")
          ? "Transcribed"
          : names.length > 0 && names.every((x) => rhythm.has(x))
            ? "Found the beats in"
            : only("silence")
              ? "Found the silences in"
              : only("loudness")
                ? "Measured the loudness of"
                : only("shots")
                  ? "Found the shots in"
                  : only("stability") || only("motion")
                    ? "Measured the camera motion of"
                    : !names.length || names.every((x) => sound.has(x))
                      ? "Analysed the sound of"
                      : names.length && names.every((x) => picture.has(x))
                        ? "Analysed the picture of"
                        : "Analysed";
      return typeof args.media === "string" ? `${what} ${args.media}` : "Analysed media";
    }
    case "media_rank": {
      const ids = typeof args.media === "string" ? [args.media] : Array.isArray(args.media) ? args.media.filter((m): m is string => typeof m === "string") : [];
      if (ids.length) return ids.length === 1 ? `Scored the take ${ids[0]}` : `Ranked ${ids.length} takes`;
      if (typeof args.folder === "string") return `Ranked the takes from ${shortName(args.folder)}`;
      return "Ranked the takes";
    }
    case "transcript_read": {
      const media = typeof args.media === "string" ? args.media : typeof args.item === "string" ? args.item : "the media";
      const range = args.range && typeof args.range === "object" ? (args.range as { start?: unknown; end?: unknown }) : undefined;
      const span = range && typeof range.start === "number" && typeof range.end === "number" ? ` (frames ${range.start}–${range.end})` : "";
      return typeof args.from === "number" && args.from > 0 ? `Read more of the transcript of ${media}${span}` : `Read the transcript of ${media}${span}`;
    }
    case "transcript_edit": {
      const what: Array<string> = [];
      const ranges = Array.isArray(args.remove) ? args.remove.length : 0;
      if (ranges) what.push(ranges === 1 ? "words" : `${ranges} word ranges`);
      if (args.pauses !== undefined) {
        const min = args.pauses && typeof args.pauses === "object" ? (args.pauses as { min?: unknown }).min : undefined;
        what.push(typeof min === "number" ? `pauses over ${min} s` : "pauses");
      }
      if (args.fillers === true) what.push("fillers");
      const list = what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what.at(-1)}` : (what[0] ?? "words");
      const from = typeof args.media === "string" ? ` from ${args.media}` : typeof args.item === "string" ? ` from ${args.item}` : "";
      return args.dryRun === true ? `Planned cutting ${list}${from}` : `Cut ${list}${from}`;
    }
    case "captions_make": {
      const how = args.mode === "word" ? "word-by-word captions" : args.mode === "single" ? "one-word captions" : "captions";
      const of = typeof args.media === "string" ? args.media : typeof args.item === "string" ? args.item : undefined;
      return of ? `Made ${how} for ${of}` : `Made ${how}`;
    }
    case "subtitles_export": {
      const format =
        typeof args.path === "string" && /\.vtt$/i.test(args.path)
          ? "WebVTT"
          : typeof args.path === "string" && /\.srt$/i.test(args.path)
            ? "SRT"
            : args.format === "vtt"
              ? "WebVTT"
              : "SRT";
      return typeof args.path === "string" ? `Saved the subtitles as ${shortName(args.path)}` : `Saved the subtitles as ${format}`;
    }
    case "export_video":
      return typeof args.folder === "string" && args.folder.trim()
        ? `Exported the video to ${shortName(args.folder.trim().replace(/\/+$/, ""))}`
        : "Exported the video";
    case "graphic_write":
      if (typeof args.from === "string") return `Edited the graphic ${args.from.replace(/^graphics\//, "")}`;
      return typeof args.name === "string" ? `Wrote the graphic ${args.name}` : "Wrote a graphic";
    case "shader_write":
      return typeof args.name === "string" ? `Wrote the shader effect ${args.name}` : "Wrote a shader effect";
    case "generate_media": {
      const what =
        args.kind === "video"
          ? "a video"
          : args.kind === "audio"
            ? "a sound"
            : args.generator === "generate.sound"
              ? "a sound"
              : args.generator === "generate.veo"
                ? "a video"
                : "a picture";
      const by =
        args.generator === "generate.gpt-image"
          ? " with GPT Image"
          : args.generator === "generate.veo"
            ? " with Veo"
            : args.generator === "generate.sound"
              ? " with ElevenLabs"
              : args.generator === "generate.svg"
                ? " from SVG"
                : "";
      // A plugin's generators (#107, #108).
      if (args.generator === "generate.elevenlabs.voiceover") return "Generated a voiceover with ElevenLabs";
      if (args.generator === "generate.elevenlabs.music") return "Generated music with ElevenLabs";
      return `Generated ${what}${by}`;
    }
    case "screen_record":
      return typeof args.source === "string" ? `Asked to record ${args.source.slice(0, 60)}` : "Asked to record the screen";
    case "argent_boot":
      return typeof args.device === "string" && args.device.trim() ? `Asked to boot ${args.device.trim().slice(0, 60)}` : "Looked for simulators to boot";
    case "media_search":
      return typeof args.query === "string" && args.query.trim()
        ? `Searched other projects for "${args.query.trim().slice(0, 60)}"`
        : "Looked through other projects' media";
    case "project_check":
      return "Checked the video against the taste checks";
    case "library_search": {
      const what = typeof args.query === "string" ? `"${args.query}"` : "";
      return `Searched the ${args.kind === "sfx" ? "sound effects" : "music"} library${what ? ` for ${what}` : ""}`;
    }
    case "library_add":
      return typeof args.id === "string" && args.id.startsWith("sfx:") ? "Added a bundled sound effect" : "Added a sound from the library";
    case "ui_show": {
      const parts: Array<string> = [];
      // D235: a pill the user clicks; the agent never moves the playhead or selects.
      const select = Array.isArray(args.select) ? args.select.find((s): s is string => typeof s === "string") : undefined;
      const at = [...(typeof args.frame === "number" ? [`frame ${args.frame}`] : []), ...(select ? [select] : [])];
      if (at.length) parts.push(`pointed at ${at.join(" and ")}`);
      if (typeof args.panel === "string")
        parts.push(`opened ${args.panel === "agent" ? "the Agent tab" : `the ${args.panel[0]!.toUpperCase()}${args.panel.slice(1)} panel`}`);
      const text = parts.join(", ") || "pointed at the editor";
      return `${text[0]!.toUpperCase()}${text.slice(1)}`;
    }
    case "ask_user":
      return typeof args.question === "string" && args.question.trim() ? `Asked: ${args.question.trim().slice(0, 100)}` : "Asked a question";
    case "brief_write":
      return "Wrote the brief";
    case "storyboard_propose": {
      const n = Array.isArray(args.beats) ? args.beats.length : 0;
      return n ? `Proposed a storyboard of ${n} beat${n === 1 ? "" : "s"}` : "Proposed a storyboard";
    }
    case "review_submit": {
      const n = Array.isArray(args.fixes) ? args.fixes.length : 0;
      return n ? `Asked the critic to check ${n} fix${n === 1 ? "" : "es"}` : "Asked the critic for a review";
    }
    case "plan_read":
      return "Read the plan";
    case "docs_read":
      return typeof args.topic === "string" && args.topic.trim() ? `Read the ${clip(args.topic.trim(), 30)} reference` : "Read the reference";
    case "skill_read":
      return typeof args.name === "string" && args.name.trim() ? `Read the skill ${clip(args.name.trim(), 60)}` : "Read a skill";
    case "brand_read":
      return typeof args.file === "string" ? `Read ${shortName(args.file)} from the brand kit` : "Read the brand kit";
    case "brand_write":
      return args.style
        ? `Wrote a style guide into ${typeof args.name === "string" ? args.name : typeof args.kit === "string" ? args.kit : "the brand kit"}`
        : `Saved the brand kit${typeof args.name === "string" ? ` ${args.name}` : ""}`;
    case "reference_frames":
      return typeof args.path === "string" ? `Looked over the reference ${shortName(args.path)}` : "Looked over a reference";
    case "beat_grid":
      return Array.isArray(args.snap) && args.snap.length
        ? `Put ${args.snap.length} moment${args.snap.length === 1 ? "" : "s"} on the beat`
        : "Read the beat grid";
    default:
      return plugin ? `Used ${tool} from ${plugin}` : `Used ${tool}`;
  }
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A web address for people: the host and path, no scheme, no www, no query (D194). */
export function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    return clip(`${u.hostname.replace(/^www\./, "")}${path}`, 70);
  } catch {
    return clip(url, 70);
  }
}

/**
 * D194: Claude Code's built-in tools in the work log, with their target: Searched the web for
 * "…", Read example.dev, Ran `ls media`, Read ~/Downloads/logo.svg, Started a subagent
 * "…". Undefined for a tool that isn't one of them.
 */
function builtinLabel(tool: string, args: Record<string, unknown>, project?: string): string | undefined {
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string).trim() : "");
  const path = (k = "file_path") => (s(k) ? shownPath(s(k), project) : "");
  switch (tool) {
    case "WebSearch":
      return s("query") ? `Searched the web for "${clip(s("query"), 80)}"` : "Searched the web";
    case "WebFetch":
      return s("url") ? `Read ${shownUrl(s("url"))}` : "Read a web page";
    case "Bash": {
      const command = s("command");
      if (!command) return "Ran a command";
      const lines = command.split("\n").length;
      const first = shellSegments(command)[0] ?? command;
      return `Ran \`${clip(first.split("\n")[0]!, 70)}\`${lines > 1 || shellSegments(command).length > 1 ? " and more" : ""}`;
    }
    case "BashOutput":
      return "Checked a command's output";
    case "KillShell":
    case "KillBash":
      return "Stopped a command";
    case "Read":
      return path() ? `Read ${path()}` : "Read a file";
    case "NotebookRead":
      return path("notebook_path") ? `Read ${path("notebook_path")}` : "Read a notebook";
    case "Write":
      return path() ? `Wrote ${path()}` : "Wrote a file";
    case "Edit":
    case "MultiEdit":
      return path() ? `Edited ${path()}` : "Edited a file";
    case "NotebookEdit":
      return path("notebook_path") ? `Edited ${path("notebook_path")}` : "Edited a notebook";
    case "Glob":
      return s("pattern") ? `Looked for files matching ${clip(s("pattern"), 60)}${s("path") ? ` in ${path("path")}` : ""}` : "Looked for files";
    case "Grep":
      return s("pattern") ? `Searched the files for "${clip(s("pattern"), 60)}"${s("path") ? ` in ${path("path")}` : ""}` : "Searched the files";
    case "LS":
      return s("path") ? `Listed ${path("path")}` : "Listed a folder";
    case "Task":
    case "Agent":
      return s("description") ? `Started a subagent "${clip(s("description"), 80)}"` : "Started a subagent";
    case "Skill":
      return s("skill") || s("command") ? `Used the skill ${clip(s("skill") || s("command"), 60)}` : "Used a skill";
    case "TodoWrite":
      return "Updated the to-do list";
    case "media_download":
      return s("url") ? `Downloaded ${s("name") ? `${clip(s("name"), 50)} from ` : ""}${shownUrl(s("url"))}` : "Downloaded a file";
    default:
      return undefined;
  }
}

// Past tense (a step's text) to present (the now line, D182): the first word(s) of a step label.
const PRESENT: ReadonlyArray<[string, string]> = [
  ["Asked to ", "Asking to "],
  ["Asked: ", "Asking: "],
  ["Asked ", "Asking "],
  ["Wrote ", "Writing "],
  ["Exported ", "Exporting "],
  ["Proposed ", "Proposing "],
  ["Reviewed ", "Reviewing "],
  ["Put ", "Putting "],
  ["Looked at ", "Looking at "],
  ["Looked over ", "Looking over "],
  ["Looked for ", "Looking for "],
  ["Looked through ", "Looking through "],
  ["Found ", "Finding "],
  ["Read ", "Reading "],
  ["Imported ", "Importing "],
  ["Analysed ", "Analysing "],
  ["Transcribed ", "Transcribing "],
  ["Measured ", "Measuring "],
  ["Scored ", "Scoring "],
  ["Ranked ", "Ranking "],
  ["Planned ", "Planning "],
  ["Cut ", "Cutting "],
  ["Made ", "Making "],
  ["Saved ", "Saving "],
  ["Generated ", "Generating "],
  ["Checked ", "Checking "],
  ["Searched ", "Searching "],
  ["Added ", "Adding "],
  ["Moved ", "Moving "],
  ["Selected ", "Selecting "],
  ["Opened ", "Opening "],
  ["Pointed ", "Pointing "],
  ["Used ", "Using "],
  ["Ran ", "Running "],
  ["Started ", "Starting "],
  ["Edited ", "Editing "],
  ["Updated ", "Updating "],
  ["Listed ", "Listing "],
  ["Stopped ", "Stopping "],
  ["Downloaded ", "Downloading "],
];

/**
 * What a running step is doing, for the now line (D182): present tense with its target ("Writing
 * graphic s3-enter.html", "Editing the timeline: Scene 2"). `input` may be the fields read so far
 * from a call still streaming in (partialFields).
 */
export function doingLabel(tool: string, input: unknown, plugin?: string, project?: string): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (tool === "timeline_edit" && args.dryRun !== true)
    return typeof args.summary === "string" && args.summary.trim() ? `Editing the timeline: ${args.summary.trim()}` : "Editing the timeline";
  if (tool === "graphic_write" && typeof args.from === "string") return `Editing graphic ${args.from.replace(/^graphics\//, "")}`;
  if (tool === "graphic_write") return typeof args.name === "string" && args.name.trim() ? `Writing graphic ${args.name.trim()}` : "Writing a graphic";
  if (tool === "shader_write")
    return typeof args.name === "string" && args.name.trim() ? `Writing shader effect ${args.name.trim()}` : "Writing a shader effect";
  const past = stepLabel(tool, input, plugin, project);
  const hit = PRESENT.find(([from]) => past.startsWith(from));
  return hit ? `${hit[1]}${past.slice(hit[0].length)}` : past;
}

/**
 * The plain string fields of a tool call's JSON input that has only partly arrived (D182): name,
 * summary, path, media and the like, each once its closing quote is in. Enough for the now line.
 */
export function partialFields(json: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re =
    /"(name|topic|summary|path|media|source|device|kind|generator|query|mode|id|folder|panel|question|file|kit|url|command|file_path|pattern|description)"\s*:\s*"((?:[^"\\]|\\.){0,200})"/g;
  for (let m = re.exec(json); m; m = re.exec(json)) {
    if (out[m[1]!] !== undefined) continue;
    try {
      out[m[1]!] = JSON.parse(`"${m[2]}"`) as string;
    } catch {}
  }
  return out;
}
