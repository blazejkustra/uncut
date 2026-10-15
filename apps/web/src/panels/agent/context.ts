import { friendlyText } from "@uncut/core/mentions";
import { createContext, useContext } from "react";
import type { Project } from "../../state/store.ts";

/** The project, for names instead of ids in what the cards show (AG5). */
export const ProjectContext = createContext<Project | undefined>(undefined);
export const useFriendly = () => {
  const project = useContext(ProjectContext);
  return (text: string) => friendlyText(project as never, text);
};
