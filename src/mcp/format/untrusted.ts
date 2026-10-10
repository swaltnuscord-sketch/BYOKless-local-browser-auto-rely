/**
 * Untrusted page content delimiter (FR-CN-03 / SEC-04).
 *
 * All text extracted from the DOM or web pages is wrapped in
 * explicit markers so the model recognizes it as untrusted data.
 */
export function wrapUntrusted(text: string): string {
  if (!text) {
    return "<untrusted_page_content></untrusted_page_content>";
  }
  return `<untrusted_page_content>\n${text}\n</untrusted_page_content>`;
}
