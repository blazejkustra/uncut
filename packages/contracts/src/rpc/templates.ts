import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { RPC_METHODS } from "../server.ts";
import { TemplateError, TemplateFilled, TemplateInfo } from "../templates.ts";

// ---- templates (issue #111) ----

/** Every template: the built-ins first, then the user's own by name. */
export const TemplatesListRpc = Rpc.make(RPC_METHODS.templatesList, { payload: Schema.Struct({}), success: Schema.Array(TemplateInfo), error: TemplateError });
/** Saves one of the user's templates (<dataDir>/templates/<id>.md); a built-in's id is refused (duplicate it). Answers the new list. */
export const TemplatesSaveRpc = Rpc.make(RPC_METHODS.templatesSave, {
  payload: Schema.Struct({ template: TemplateInfo }),
  success: Schema.Array(TemplateInfo),
  error: TemplateError,
});
export const TemplatesDeleteRpc = Rpc.make(RPC_METHODS.templatesDelete, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Array(TemplateInfo),
  error: TemplateError,
});
/** A template with its placeholders filled from the open project (none open: only the template's fallbacks and notes). */
export const TemplatesFillRpc = Rpc.make(RPC_METHODS.templatesFill, {
  payload: Schema.Struct({ id: Schema.String }),
  success: TemplateFilled,
  error: TemplateError,
});
