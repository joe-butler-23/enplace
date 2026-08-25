import * as React from "react";
import {
  codeBlockPlugin,
  headingsPlugin,
  imagePlugin,
  linkPlugin,
  listsPlugin,
  markdownShortcutPlugin,
  MDXEditor,
  quotePlugin,
  tablePlugin,
  thematicBreakPlugin
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";

type RecipeEditorProps = {
  path: string;
  markdown: string;
  onChange: (markdown: string) => void;
  onClose: () => void;
};

export function RecipeEditor({
  path,
  markdown,
  onChange,
  onClose
}: RecipeEditorProps): React.ReactElement {
  return (
    <div className="recipe-view__editor">
      <div className="recipe-view__editor-actions">
        <button type="button" onClick={onClose}>Done</button>
      </div>
      <MDXEditor
        key={path}
        className="recipe-view__mdx-editor"
        markdown={markdown}
        onChange={onChange}
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          linkPlugin(),
          imagePlugin({ disableImageResize: true }),
          tablePlugin(),
          codeBlockPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          markdownShortcutPlugin()
        ]}
      />
    </div>
  );
}
