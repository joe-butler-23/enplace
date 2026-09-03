import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
export type RecipeImageResources = { resolveImage: (src: string, path: string) => string | null };

// Stable across renders and across the two renderers below: react-markdown builds a
// fresh unified processor per render, so a fresh array here would defeat memoisation
// even where a memo boundary compares props by reference.
const remarkPlugins = [remarkGfm];

function ReadImage({ src, alt, imageTitle, path, resolveImage }: RecipeImageResources & { src: string; alt?: string; imageTitle?: string; path: string }): React.ReactElement {
  const url = resolveImage(src, path);
  return <figure className="recipe-view__image">{url
    ? <img src={url} alt={alt ?? ""} title={imageTitle} loading="eager" decoding="async" />
    : <div className="recipe-view__image-error" role="img" aria-label={`${alt || "Image"} unavailable`}>Image unavailable</div>}
  </figure>;
}

export function ReadDocument({
  markdown, path, resolveImage
}: RecipeImageResources & { markdown: string; path: string }): React.ReactElement {
  // Not wrapped in useMemo: ReadDocument is called directly (outside a component render) by
  // an existing test, so it must stay a hook-free plain function. The toggle-driven reparse
  // this defect describes is instead prevented one level up, at the PreparedRecipeDocument
  // memo boundary in RecipeView.tsx, which stops this function from being invoked at all when
  // its props are unchanged.
  return (
    <div className="recipe-view__read-document">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        components={{
          img: ({ src, alt, title }) => (
            <ReadImage src={src ?? ""} alt={alt} imageTitle={title} path={path} resolveImage={resolveImage} />
          )
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

/** Renders children as inline, not wrapped in `<p>` — a method step is a list row, not a block. */
const inlineComponents: Components = { p: ({ children }) => <>{children}</> };

/** A single step's markdown, rendered inline (bold/italic/links/code) with no block wrapper. */
export function ReadInline({ text }: { text: string }): React.ReactElement {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={inlineComponents}>
      {text}
    </ReactMarkdown>
  );
}
