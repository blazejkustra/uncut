// Every action, one object (components call actions.x); each group lives in actions/*.
import { environmentActions } from "./actions/environments.ts";
import { remoteActions } from "./actions/remote.ts";
import { projectActions, projectFileActions } from "./actions/project.ts";
import { mediaActions } from "./actions/media.ts";
import { timelineActions } from "./actions/timeline.ts";
import { agentActions } from "./actions/agent.ts";
import { brandActions } from "./actions/brand.ts";
import { exportActions } from "./actions/export.ts";
import { settingsActions } from "./actions/settings.ts";
import { captureActions } from "./actions/capture.ts";
import { generateActions } from "./actions/generate.ts";

export const actions = {
  ...environmentActions,
  ...remoteActions,
  ...projectActions,
  ...mediaActions,
  ...timelineActions,
  ...projectFileActions,
  ...agentActions,
  ...brandActions,
  ...exportActions,
  ...settingsActions,
  ...captureActions,
  ...generateActions,
};
