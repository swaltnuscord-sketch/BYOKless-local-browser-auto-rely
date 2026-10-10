import { wrapUntrusted } from "./untrusted.js";

/**
 * Formats tool results into human- and model-readable markdown.
 */
export function formatToolMarkdown(tool: string, data: Record<string, unknown>): string {
  const summary = typeof data.summary === "string" ? data.summary : `${tool} succeeded`;

  if (tool === "read_page") {
    const content = typeof data.content === "string" ? data.content : "";
    return `${summary}\n\n${wrapUntrusted(content)}`;
  }

  if (tool === "find_elements" && Array.isArray(data.elements)) {
    const formatted = JSON.stringify(data.elements, null, 2);
    return `${summary}\n\n${wrapUntrusted(formatted)}`;
  }

  if (tool === "extract_content" && typeof data.extracted === "string") {
    return `${summary}\n\n${wrapUntrusted(data.extracted)}`;
  }

  return summary;
}
