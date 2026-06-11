import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { runCli } from "../../src/run.js";

const LIVE = process.env.SUMMARIZE_LIVE_TEST === "1";

(LIVE ? describe : describe.skip)("live mickel.tech inline CSS perf", () => {
  it("extracts quickly with large inline CSS", async () => {
    let stdoutText = "";
    let stderrText = "";

    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString();
        callback();
      },
    });
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        stderrText += chunk.toString();
        callback();
      },
    });

    const url = "https://mickel.tech/log/merchants-of-complexity";
    const start = performance.now();

    await runCli(
      [
        "--json",
        "--extract-only",
        "--format",
        "text",
        "--firecrawl",
        "off",
        "--timeout",
        "60s",
        url,
      ],
      {
        env: { ...process.env },
        fetch: globalThis.fetch.bind(globalThis),
        stdout,
        stderr,
      },
    );

    const durationMs = performance.now() - start;
    expect(stderrText).not.toContain("Could not parse CSS stylesheet");

    const parsed = JSON.parse(stdoutText) as { extracted?: { content?: string } };
    // Site content/markup can change; keep this as a non-trivial extraction guard.
    expect(parsed.extracted?.content?.length ?? 0).toBeGreaterThan(80);
    expect(durationMs).toBeLessThan(20_000);
  }, 90_000);
});
