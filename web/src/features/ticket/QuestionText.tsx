import { useMemo } from "react";
import { miniMarkdown } from "./miniMarkdown";

/** Question-form text as safe, small markdown (see miniMarkdown.ts); `as` span keeps it inline in a line. */
export function QuestionText({ text, className = "", as: Tag = "div", title }: { text: string; className?: string; as?: "div" | "span"; title?: string }) {
  const html = useMemo(() => miniMarkdown(text), [text]);
  return <Tag className={`qmd ${className}`.trim()} title={title} dangerouslySetInnerHTML={{ __html: html }} />;
}
