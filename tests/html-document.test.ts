import { describe, expect, it } from "vitest";
import {
  parseHtmlDocument,
  serializeHtmlDocument,
} from "../packages/core/src/content/html-document.js";
import { extractReadabilityFromHtml } from "../packages/core/src/content/link-preview/content/readability.js";

describe("HTML document adapter", () => {
  it("wraps fragments and keeps the doctype outside the body", () => {
    const parsed = parseHtmlDocument('<!doctype html><p id="content">Hello</p>');
    try {
      expect(parsed.document.documentElement?.tagName.toLowerCase()).toBe("html");
      expect(parsed.document.head).not.toBeNull();
      expect(parsed.document.body?.querySelector("#content")?.textContent).toBe("Hello");
      const serialized = serializeHtmlDocument(parsed.document);
      expect(serialized.match(/<!doctype/gi)).toHaveLength(1);
      expect(parsed.document.body?.innerHTML).not.toContain("doctype");
    } finally {
      parsed.close();
    }
  });

  it("moves malformed document children into the body for Readability", async () => {
    const html = `<html><div><article><h1>Malformed article</h1>
      <p>This paragraph contains enough useful prose for article extraction to recognize it.</p>
      <p>A second substantial paragraph ensures that the document is considered readable.</p>
    </article></div></html>`;

    const result = await extractReadabilityFromHtml(html, "https://example.com/article");
    expect(result?.text).toContain("Malformed article");
    expect(result?.text).toContain("second substantial paragraph");
  });

  it("does not mistake raw html text for the document element", () => {
    const parsed = parseHtmlDocument(
      '<textarea><html></textarea><article id="content">Still present</article>',
    );
    try {
      expect(parsed.document.body?.querySelector("#content")?.textContent).toBe("Still present");
      expect(parsed.document.body?.querySelector("textarea")?.textContent).toBe("<html>");
    } finally {
      parsed.close();
    }
  });

  it("normalizes documents with optional html tags", () => {
    const parsed = parseHtmlDocument(
      "<!doctype html><head><title>Optional tags</title></head><body><p>Body</p></body>",
    );
    try {
      expect(parsed.document.head?.querySelector("title")?.textContent).toBe("Optional tags");
      expect(parsed.document.body?.textContent).toBe("Body");
      expect(parsed.document.body?.querySelector("head, body")).toBeNull();
    } finally {
      parsed.close();
    }
  });

  it("places leading document metadata in a synthesized head", () => {
    const parsed = parseHtmlDocument(
      '<title>Fragment title</title><meta name="description" content="Details"><article>Body</article>',
    );
    try {
      expect(parsed.document.title).toBe("Fragment title");
      expect(parsed.document.head?.querySelector('meta[name="description"]')).not.toBeNull();
      expect(parsed.document.body?.textContent).toBe("Body");
    } finally {
      parsed.close();
    }
  });

  it("recognizes full documents after an XML declaration", () => {
    const parsed = parseHtmlDocument(
      '<?xml version="1.0"?><!doctype html><html><head><title>XHTML</title></head><body><p>Body</p></body></html>',
    );
    try {
      expect(parsed.document.title).toBe("XHTML");
      expect(parsed.document.body?.textContent).toBe("Body");
    } finally {
      parsed.close();
    }
  });

  it("preserves body content order around malformed head and body tags", () => {
    const parsed = parseHtmlDocument(
      "<html><div>Before</div><head><title>Title</title></head><body><p>Main</p></body><div>After</div></html>",
    );
    try {
      expect(parsed.document.body?.textContent).toBe("BeforeMainAfter");
      expect(parsed.document.head?.querySelector("title")?.textContent).toBe("Title");
    } finally {
      parsed.close();
    }
  });

  it("resolves relative links against the page URL for Readability", async () => {
    const html = `<article><h1>Linked article</h1>
      <p>This paragraph contains enough useful prose and a <a href="/next">relative link</a>.</p>
      <p>A second substantial paragraph keeps the article extraction path deterministic.</p>
    </article>`;

    const result = await extractReadabilityFromHtml(html, "https://example.com/articles/current");
    expect(result?.html).toContain('href="https://example.com/next"');
  });

  it("does not execute scripts while parsing", () => {
    const marker = "__summarizeLinkedomExecutionMarker";
    delete (globalThis as Record<string, unknown>)[marker];
    const parsed = parseHtmlDocument(`<script>globalThis.${marker} = true</script><p>Safe</p>`);
    try {
      expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
      expect(parsed.document.body?.textContent).toContain("Safe");
    } finally {
      parsed.close();
      delete (globalThis as Record<string, unknown>)[marker];
    }
  });
});
