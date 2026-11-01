import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ArticlePage, { articleMetadata } from "../../../components/ArticlePage.tsx";
import { COMPARISONS, pathOf } from "../../../lib/compare.ts";

type Props = { params: Promise<{ slug: string }> };

export const dynamicParams = false;

export function generateStaticParams() {
  return COMPARISONS.map((c) => ({ slug: c.slug }));
}

const comparisonFor = async ({ params }: Props) => {
  const { slug } = await params;
  return COMPARISONS.find((c) => c.slug === slug);
};

export async function generateMetadata(props: Props): Promise<Metadata> {
  const comparison = await comparisonFor(props);
  return comparison ? articleMetadata(comparison, pathOf(comparison)) : {};
}

export default async function ComparisonPage(props: Props) {
  const comparison = await comparisonFor(props);
  if (!comparison) notFound();
  return <ArticlePage article={comparison} path={pathOf(comparison)} back={{ href: "/vs/", label: "All comparisons" }} />;
}
