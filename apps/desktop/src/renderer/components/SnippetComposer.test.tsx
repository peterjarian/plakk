import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SnippetComposer } from "./SnippetComposer.tsx";

describe("SnippetComposer", () => {
  it("owns the product copy and styles the host file control", () => {
    const markup = renderToStaticMarkup(
      <SnippetComposer.Root onSubmit={() => {}}>
        <SnippetComposer.Input />
        <SnippetComposer.Attachment>
          <input multiple onChange={() => {}} />
        </SnippetComposer.Attachment>
        <SnippetComposer.Submit />
      </SnippetComposer.Root>,
    );

    expect(markup).toContain('data-slot="snippet-composer"');
    expect(markup).toContain('placeholder="Paste or write whatever you want"');
    expect(markup).toContain("Choose file");
    expect(markup).toContain(">Add</button>");
    expect(markup).toContain('type="file"');
    expect(markup).toContain("sr-only");
  });
});
