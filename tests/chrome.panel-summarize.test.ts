import { describe, expect, it, vi } from "vitest";
import { summarizeActiveTab } from "../apps/chrome-extension/src/entrypoints/background/panel-summarize.js";
import { buildSummarizeRequestBody } from "../apps/chrome-extension/src/lib/daemon-payload.js";
import { defaultSettings } from "../apps/chrome-extension/src/lib/settings.js";

const youtubeUrl = "https://www.youtube.com/watch?v=KnUFH5GX_fI";

function createHarness() {
  const session = {
    windowId: 1,
    runController: null,
    inflightUrl: null,
    lastSummarizedUrl: null,
    daemonRecovery: { recordFailure: vi.fn() },
    daemonStatus: { markReady: vi.fn() },
  };
  const sent: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: true, id: body.slides ? "summary-with-slides" : "summary" }),
    } as Response;
  });

  return {
    session,
    sent,
    fetchImpl,
    summarize: (overrides: Partial<Parameters<typeof summarizeActiveTab>[0]> = {}) =>
      summarizeActiveTab({
        session,
        reason: "panel-open",
        loadSettings: vi.fn(async () => ({
          ...defaultSettings,
          token: "token",
          autoSummarize: true,
          slidesEnabled: true,
          slidesParallel: true,
          summaryTimestamps: true,
        })),
        emitState: vi.fn(),
        getActiveTab: vi.fn(async () => ({
          id: 7,
          windowId: 1,
          url: youtubeUrl,
          title: "YouTube",
        })),
        canSummarizeUrl: () => true,
        panelSessionStore: {
          isPanelOpen: () => true,
          setCachedExtract: vi.fn(),
        },
        sendStatus: vi.fn(),
        send: (message) => {
          sent.push(message);
        },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        extractFromTab: vi.fn(),
        urlsMatch: (left, right) => left === right,
        buildSummarizeRequestBody,
        friendlyFetchError: (error, fallback) =>
          error instanceof Error ? error.message : fallback,
        isDaemonUnreachableError: () => false,
        logPanel: vi.fn(),
        ...overrides,
      }),
  };
}

describe("chrome panel summarize", () => {
  it("uses one daemon summarize request for YouTube slides", async () => {
    const harness = createHarness();

    await harness.summarize();

    expect(harness.fetchImpl).toHaveBeenCalledOnce();
    const [, init] = harness.fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      url: youtubeUrl,
      mode: "url",
      timestamps: true,
      slides: true,
    });
    expect(body.videoMode).toBeUndefined();
    expect(body.extractOnly).toBeUndefined();
    expect(harness.sent).toEqual([
      {
        type: "run:start",
        run: {
          id: "summary-with-slides",
          url: youtubeUrl,
          title: "YouTube",
          model: defaultSettings.model,
          reason: "panel-open",
          slides: true,
        },
      },
    ]);
  });

  it("dedupes automatic starts for the current inflight URL", async () => {
    const harness = createHarness();
    harness.session.inflightUrl = youtubeUrl;

    await harness.summarize();

    expect(harness.fetchImpl).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
  });

  it("keeps non-YouTube URL-preferred pages out of the video transcript path", async () => {
    const harness = createHarness();
    const url = "https://x.com/example/status/1234567890123456789";

    await harness.summarize({
      getActiveTab: vi.fn(async () => ({
        id: 7,
        windowId: 1,
        url,
        title: "Post",
      })),
      extractFromTab: vi.fn(async () => ({
        ok: true,
        data: {
          ok: true,
          url,
          title: "Post",
          text: "post text",
          truncated: false,
          media: null,
        },
      })),
    });

    expect(harness.fetchImpl).toHaveBeenCalledOnce();
    const [, init] = harness.fetchImpl.mock.calls[0];
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    expect(body).toMatchObject({
      url,
      text: "post text",
      slides: true,
    });
    expect(body.mode).toBeUndefined();
    expect(body.videoMode).toBeUndefined();
  });
});
