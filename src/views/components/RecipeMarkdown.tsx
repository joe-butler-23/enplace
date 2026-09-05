import * as React from "react";
import DOMPurify from "dompurify";
import { parse, parseInline, Renderer, type Tokens } from "marked";

export type RecipeImageResources = { resolveImage: (src: string, path: string) => string | null };

const UNSAFE_LINK_STYLE = "color: var(--accent); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);";

const allowedAttributes: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "title"]),
  code: new Set(["class"]),
  div: new Set(["aria-label", "class", "role"]),
  figure: new Set(["class"]),
  img: new Set(["alt", "decoding", "src", "title"]),
  input: new Set(["checked", "disabled", "type"]),
  li: new Set(["class"]),
  ol: new Set(["start"]),
  span: new Set(["style"]),
  table: new Set([]),
  td: new Set(["align"]),
  th: new Set(["align"]),
  thead: new Set([]),
  tbody: new Set([]),
  tr: new Set([]),
  blockquote: new Set([]),
  br: new Set([]),
  del: new Set([]),
  em: new Set([]),
  h1: new Set([]),
  h2: new Set([]),
  h3: new Set([]),
  h4: new Set([]),
  h5: new Set([]),
  h6: new Set([]),
  hr: new Set([]),
  p: new Set([]),
  pre: new Set([]),
  strong: new Set([]),
  ul: new Set(["class"]),
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function decodeTarget(target: string): string {
  if (!target.includes("&")) return target;
  const decoder = document.createElement("textarea");
  // Decode character references in a detached raw-text element. Escaping '<'
  // ensures user input cannot introduce any element or leave that context.
  decoder.innerHTML = target.replace(/</g, "&lt;");
  return decoder.value;
}

function isAllowedTarget(target: string): boolean {
  const normalized = decodeTarget(target).trim().replace(/[\u0000-\u0020\u007f]+/g, "");
  if (!normalized || normalized.startsWith("//") || normalized.startsWith("\\")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(normalized)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto" || scheme === "tel";
}

function isAllowedAttribute(tag: string, name: string, value: string): boolean {
  if (!allowedAttributes[tag]?.has(name)) return false;
  if (name === "href") return isAllowedTarget(value);
  if (name === "class") {
    return /^(?:contains-task-list|task-list-item|language-[a-z0-9_-]+|recipe-view__image|recipe-view__image-error)$/i.test(value);
  }
  if (name === "style") return tag === "span" && value === UNSAFE_LINK_STYLE;
  if (name === "role") return tag === "div" && value === "img";
  if (name === "decoding") return value === "sync";
  if (name === "type") return tag === "input" && value === "checkbox";
  if (name === "checked" || name === "disabled") return tag === "input" && value === "";
  if (name === "start") return /^-?\d+$/.test(value);
  if (name === "align") return value === "left" || value === "center" || value === "right";
  if (name === "src") return /^(?:blob:|data:image\/(?:png|jpeg|gif|webp|avif);|\/(?![\\/]))/i.test(value);
  return true;
}

// DOMPurify parses with the browser's HTML parser before checking decoded attributes.
// Raw recipe HTML remains escaped; only Markdown-generated HTML reaches this boundary.
DOMPurify.addHook("uponSanitizeAttribute", (node, attribute) => {
  attribute.keepAttr = isAllowedAttribute(node.nodeName.toLowerCase(), attribute.attrName, attribute.attrValue);
});

function sanitizeRenderedHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: Object.keys(allowedAttributes),
    ALLOWED_ATTR: [...new Set(Object.values(allowedAttributes).flatMap((attributes) => [...attributes]))],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ADD_URI_SAFE_ATTR: ["src"], // The hook permits only local image resources, including blob URLs.
  });
}

function rendererFor(path: string, resolveImage: RecipeImageResources["resolveImage"]): Renderer {
  const renderer = new Renderer();
  renderer.html = ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text);
  renderer.image = ({ href, title, text }: Tokens.Image) => {
    const url = resolveImage(href, path);
    const alt = text || "";
    if (!url) {
      return `<figure class="recipe-view__image"><div class="recipe-view__image-error" role="img" aria-label="${escapeHtml(`${alt || "Image"} unavailable`)}">Image unavailable</div></figure>`;
    }
    const imageTitle = title ? ` title="${escapeHtml(title)}"` : "";
    return `<figure class="recipe-view__image"><img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}"${imageTitle} decoding="sync"></figure>`;
  };
  renderer.link = function ({ href, title, text, tokens }: Tokens.Link) {
    if (!isAllowedTarget(href)) {
      // Keep the old link colour while removing all link semantics and interaction.
      return `<span style="${UNSAFE_LINK_STYLE}">${escapeHtml(text)}</span>`;
    }
    const linkTitle = title ? ` title="${escapeHtml(title)}"` : "";
    return `<a href="${escapeHtml(decodeTarget(href))}"${linkTitle}>${this.parser.parseInline(tokens)}</a>`;
  };
  return renderer;
}

function renderMarkdown(markdown: string, path = "", resolveImage: RecipeImageResources["resolveImage"] = () => null, inline = false): string {
  const renderer = rendererFor(path, resolveImage);
  const html = inline
    ? parseInline(markdown, { async: false, gfm: true, renderer })
    : parse(markdown, { async: false, gfm: true, renderer });
  return sanitizeRenderedHtml(html);
}

export function ReadDocument({
  markdown, path, resolveImage
}: RecipeImageResources & { markdown: string; path: string }): React.ReactElement {
  return (
    <div
      className="recipe-view__read-document"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(markdown, path, resolveImage) }}
    />
  );
}

/** A single step's Markdown, rendered inline with no block wrapper. */
export function ReadInline({ text }: { text: string }): React.ReactElement {
  return <span dangerouslySetInnerHTML={{ __html: renderMarkdown(text, "", () => null, true) }} />;
}
