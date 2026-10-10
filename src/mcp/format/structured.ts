import { wrapUntrusted } from "./untrusted.js";

/**
 * Formats structured tool responses ensuring page-derived fields are marked.
 */
export function formatStructuredContent(
  tool: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...data };

  if (tool === "read_page" && typeof result.content === "string") {
    result.untrustedContent = wrapUntrusted(result.content);
  }

  return result;
}
