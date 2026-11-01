import ArticlePage, { articleMetadata } from "../../../components/ArticlePage.tsx";
import { GUIDE, GUIDE_PATH } from "../../../lib/compare.ts";

export const metadata = articleMetadata(GUIDE, GUIDE_PATH);

export default function ClaudeCodeGuide() {
  return <ArticlePage article={GUIDE} path={GUIDE_PATH} />;
}
