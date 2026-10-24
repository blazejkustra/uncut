// The remote file browser (D107): on a remote environment it stands in for every native dialog
// that would otherwise show this Mac's disk (open a project, where a new one goes, import, where an
// export goes, a plugin folder). It lists the server's folders over files.list; nothing is written
// here. For imports it also offers Upload from this Mac (D108).
import type { FileEntry, FileListing } from "@uncut/contracts";
import { ArrowUp, Clapperboard, File as FileIcon, Folder, House, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { shortPath } from "../state/format.ts";
import { actions, useApp, type RemotePickerRequest } from "../state/store.ts";
import { Tooltip } from "../ui/Tooltip.tsx";

const TITLES: Record<RemotePickerRequest["purpose"], string> = {
  project: "Open a project",
  parent: "Where to save the project",
  plugin: "Add a plugin folder",
  media: "Import media",
  save: "Where to save the export",
};

const sizeText = (n: number | undefined) =>
  n === undefined
    ? ""
    : n < 1024 ** 2
      ? `${Math.max(1, Math.round(n / 1024))} KB`
      : n < 1024 ** 3
        ? `${(n / 1024 ** 2).toFixed(1)} MB`
        : `${(n / 1024 ** 3).toFixed(2)} GB`;
const join = (dir: string, name: string) => `${dir.replace(/\/$/, "")}/${name}`;

export function RemoteBrowser({ request }: { request: RemotePickerRequest }) {
  const { environment, appInfo } = useApp();
  const [listing, setListing] = useState<FileListing | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReadonlyArray<string>>([]);
  const [fileName, setFileName] = useState(request.fileName ?? "");
  const upload = useRef<HTMLInputElement>(null);
  const { purpose } = request;

  const go = async (dir?: string) => {
    setLoading(true);
    const result = await actions.listFolder(dir);
    setLoading(false);
    if ("problem" in result) return setProblem(result.problem);
    setProblem(undefined);
    setListing(result.listing);
    setSelected([]);
  };
  useEffect(() => {
    void go(request.start);
  }, [request.seq]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      actions.answerPicker(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const dir = listing?.dir;
  const open = (e: FileEntry) => {
    if (!dir) return;
    const path = join(dir, e.name);
    // A project folder opens straight away when opening a project; elsewhere folders are entered.
    if (e.kind === "dir" && purpose === "project" && e.project) return actions.answerPicker(path);
    if (e.kind === "dir") return void go(path);
    if (purpose === "media") return actions.answerPicker([path]);
    if (purpose === "save") setFileName(e.name);
  };
  const click = (e: FileEntry) => {
    if (!dir) return;
    const path = join(dir, e.name);
    if (purpose === "media" && e.kind === "file") return setSelected((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]));
    if (purpose === "save" && e.kind === "file") return setFileName(e.name);
    if (e.kind === "dir" && (purpose === "project" ? e.project : false)) return setSelected([path]);
    if (e.kind === "dir") return void go(path);
  };

  const name = fileName.trim();
  const choice: string | ReadonlyArray<string> | undefined = !dir
    ? undefined
    : purpose === "media"
      ? selected.length
        ? selected
        : undefined
      : purpose === "project"
        ? selected[0]
        : purpose === "save"
          ? name && !name.includes("/")
            ? join(dir, /\.mp4$/i.test(name) ? name : `${name}.mp4`)
            : undefined
          : dir;
  const confirmLabel =
    purpose === "media"
      ? selected.length > 1
        ? `Import ${selected.length} files`
        : "Import"
      : purpose === "project"
        ? "Open"
        : purpose === "plugin"
          ? "Add this folder"
          : purpose === "save"
            ? "Choose"
            : "Choose this folder";
  const shown = (listing?.entries ?? []).filter((e) => purpose === "media" || purpose === "save" || e.kind === "dir");

  return (
    <div className="modal-layer" data-testid="remote-browser" data-purpose={purpose}>
      <div className="modal wiz remote-browser">
        <div className="wiz-header row">
          <div>
            <div className="wiz-brand small">{TITLES[purpose]}</div>
            <div className="wiz-sub">On {environment.name}. These are the server's folders, not this Mac's.</div>
          </div>
          <Tooltip label="Cancel" keys={["Esc"]}>
            <button className="icon-btn" data-testid="remote-browser-cancel" onClick={() => actions.answerPicker(null)}>
              <X />
            </button>
          </Tooltip>
        </div>
        <div className="wiz-panel">
          <div className="remote-path">
            <Tooltip label="Up one folder">
              <button
                className="icon-btn"
                data-testid="remote-browser-up"
                disabled={!listing?.parent || loading}
                onClick={() => listing?.parent && void go(listing.parent)}
              >
                <ArrowUp />
              </button>
            </Tooltip>
            <Tooltip label="Home folder">
              <button className="icon-btn" data-testid="remote-browser-home" disabled={loading} onClick={() => void go(listing?.home)}>
                <House />
              </button>
            </Tooltip>
            <span className="mono small ellipsis grow" data-testid="remote-browser-dir" title={dir}>
              {dir ? shortPath(dir, listing?.home ?? appInfo.homeDir) : "…"}
            </span>
          </div>
          <div className="remote-list" data-testid="remote-browser-list" data-loading={loading}>
            {shown.map((e) => {
              const path = dir ? join(dir, e.name) : e.name;
              return (
                <button
                  key={e.name}
                  className={`remote-entry ${selected.includes(path) ? "active" : ""}`}
                  data-testid="remote-entry"
                  data-name={e.name}
                  data-kind={e.kind}
                  data-project={e.project ? "true" : "false"}
                  onClick={() => click(e)}
                  onDoubleClick={() => open(e)}
                >
                  {e.project ? <Clapperboard /> : e.kind === "dir" ? <Folder /> : <FileIcon />}
                  <span className="grow ellipsis">{e.name}</span>
                  {e.kind === "file" && <span className="muted small">{sizeText(e.size)}</span>}
                </button>
              );
            })}
            {listing && !shown.length && (
              <div className="wiz-sub remote-empty">{purpose === "media" || purpose === "save" ? "This folder is empty." : "No folders in here."}</div>
            )}
          </div>
          {problem && (
            <div className="inline-error" role="alert" data-testid="remote-browser-error">
              {problem}
            </div>
          )}
          {purpose === "save" && (
            <label className="wiz-field form-fields">
              <span>Name</span>
              <input data-testid="remote-browser-name" value={fileName} onChange={(e) => setFileName(e.target.value)} spellCheck={false} />
            </label>
          )}
          <div className="wiz-foot">
            {purpose === "media" ? (
              <>
                <input
                  ref={upload}
                  type="file"
                  multiple
                  hidden
                  data-testid="remote-browser-upload-input"
                  onChange={(e) => {
                    const files = [...(e.target.files ?? [])];
                    actions.answerPicker(null);
                    if (files.length) void actions.uploadAndImport(files);
                  }}
                />
                <button
                  className="btn ghost"
                  data-testid="remote-browser-upload"
                  onClick={() => upload.current?.click()}
                  title="Copies files from this Mac into the project's media/uploads folder on the server"
                >
                  <Upload />
                  Upload from this Mac…
                </button>
              </>
            ) : (
              <p>
                {purpose === "parent"
                  ? "The project folder (Name.uncut) is made inside this folder."
                  : purpose === "project"
                    ? "Pick a .uncut project folder."
                    : purpose === "plugin"
                      ? "A folder with an uncut.module.json in it."
                      : "The video stays on the server; Download brings it to this Mac."}
              </p>
            )}
            <div className="wiz-btns">
              <button className="btn ghost" onClick={() => actions.answerPicker(null)}>
                Cancel
              </button>
              <button
                className="btn primary"
                data-testid="remote-browser-choose"
                disabled={choice === undefined || loading}
                onClick={() => choice !== undefined && actions.answerPicker(choice)}
              >
                {confirmLabel}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
