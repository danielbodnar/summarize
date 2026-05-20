import { isYouTubeVideoUrl, shouldPreferUrlMode } from "@steipete/summarize-core/content/url";
import type { RunStart } from "../../lib/panel-contracts";
import type { Settings } from "../../lib/settings";
import type { ExtractResponse } from "./content-script-bridge";
import type { CachedExtract } from "./extract-cache";
import { routeExtract, type ExtractorContext, type ExtractorResult } from "./extractors/router";

type DaemonRecoveryLike = {
  recordFailure: (url: string) => void;
};

type DaemonStatusLike = {
  markReady: () => void;
};

type BackgroundSummarizeSession = {
  windowId: number;
  runController: AbortController | null;
  inflightUrl: string | null;
  lastSummarizedUrl: string | null;
  daemonRecovery: DaemonRecoveryLike;
  daemonStatus: DaemonStatusLike;
};

type StoreLike = {
  isPanelOpen: (session: BackgroundSummarizeSession) => boolean;
  setCachedExtract: (tabId: number, value: CachedExtract) => void;
};

type SendFn = (
  msg: { type: "run:error"; message: string } | { type: "run:start"; run: RunStart },
) => void;

export async function summarizeActiveTab({
  session,
  reason,
  opts,
  loadSettings,
  emitState,
  getActiveTab,
  canSummarizeUrl,
  panelSessionStore,
  sendStatus,
  send,
  fetchImpl,
  extractFromTab,
  urlsMatch,
  buildSummarizeRequestBody,
  friendlyFetchError,
  isDaemonUnreachableError,
  logPanel,
}: {
  session: BackgroundSummarizeSession;
  reason: string;
  opts?: { refresh?: boolean; inputMode?: "page" | "video" };
  loadSettings: () => Promise<Settings>;
  emitState: (session: BackgroundSummarizeSession, status: string) => Promise<void>;
  getActiveTab: (windowId?: number) => Promise<chrome.tabs.Tab | null>;
  canSummarizeUrl: (url?: string | null) => boolean;
  panelSessionStore: StoreLike;
  sendStatus: (status: string) => void;
  send: SendFn;
  fetchImpl: typeof fetch;
  extractFromTab: ExtractorContext["extractFromTab"];
  urlsMatch: (left: string, right: string) => boolean;
  buildSummarizeRequestBody: (args: {
    extracted: ExtractResponse & { ok: true };
    settings: Settings;
    noCache: boolean;
    inputMode?: "page" | "video";
    timestamps: boolean;
    slides:
      | { enabled: false }
      | {
          enabled: true;
          ocr: boolean;
          maxSlides: number | null;
          minDurationSeconds: number | null;
        };
  }) => Record<string, unknown>;
  friendlyFetchError: (error: unknown, fallback: string) => string;
  isDaemonUnreachableError: (error: unknown) => boolean;
  logPanel: (event: string, detail?: Record<string, unknown>) => void;
}) {
  if (!panelSessionStore.isPanelOpen(session)) return;

  const settings = await loadSettings();
  const isManual = reason === "manual" || reason === "refresh" || reason === "length-change";
  if (!isManual && !settings.autoSummarize) return;
  if (!settings.token.trim()) {
    await emitState(session, "Setup required (missing token)");
    return;
  }

  if (reason === "spa-nav" || reason === "tab-url-change") {
    await new Promise((resolve) => setTimeout(resolve, 220));
  }

  const tab = await getActiveTab(session.windowId);
  if (!tab?.id || !canSummarizeUrl(tab.url)) return;
  const tabUrl = tab.url ?? "";
  if (
    settings.autoSummarize &&
    ((session.lastSummarizedUrl && urlsMatch(session.lastSummarizedUrl, tabUrl)) ||
      (session.inflightUrl && urlsMatch(session.inflightUrl, tabUrl))) &&
    !isManual
  ) {
    sendStatus("");
    return;
  }

  session.runController?.abort();
  const controller = new AbortController();
  session.runController = controller;
  session.inflightUrl = tabUrl;
  const isSuperseded = () => controller.signal.aborted || session.runController !== controller;

  const prefersUrlMode = Boolean(tab.url && shouldPreferUrlMode(tab.url));
  const wantsUrlDirectPath =
    Boolean(tab.url && isYouTubeVideoUrl(tab.url)) && opts?.inputMode !== "page" && prefersUrlMode;

  let extracted: ExtractResponse & { ok: true };
  let routedResult: Pick<ExtractorResult, "source" | "diagnostics"> | null = null;
  if (wantsUrlDirectPath) {
    logPanel("extractor.route.start", { tabId: tab.id, preferUrl: prefersUrlMode });
    logPanel("extractor.route.preferUrlHardSwitch", { tabId: tab.id });
    sendStatus(`Preparing video… (${reason})`);
    logPanel("extract:url-direct", { reason, tabId: tab.id });
    extracted = {
      ok: true,
      url: tab.url,
      title: tab.title ?? null,
      text: "",
      truncated: false,
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
    };
  } else {
    sendStatus(`Extracting… (${reason})`);
    logPanel("extract:start", { reason, tabId: tab.id, maxChars: settings.maxChars });
    const statusFromExtractEvent = (event: string) => {
      if (!panelSessionStore.isPanelOpen(session)) return;
      if (event === "extract:attempt") {
        sendStatus(`Extracting page content… (${reason})`);
        return;
      }
      if (event === "extract:inject:ok") {
        sendStatus(`Extracting: injecting… (${reason})`);
        return;
      }
      if (event === "extract:message:ok") {
        sendStatus(`Extracting: reading… (${reason})`);
      }
    };
    if (prefersUrlMode) {
      logPanel("extractor.route.start", { tabId: tab.id, preferUrl: true });
      logPanel("extractor.route.preferUrlHardSwitch", { tabId: tab.id });
      const extractedAttempt = await extractFromTab(tab.id, settings.maxChars, {
        timeoutMs: 8_000,
        log: (event, detail) => {
          statusFromExtractEvent(event);
          logPanel(event, detail);
        },
      });
      if (isSuperseded()) return;
      logPanel(extractedAttempt.ok ? "extract:done" : "extract:failed", {
        ok: extractedAttempt.ok,
        ...(extractedAttempt.ok
          ? { url: extractedAttempt.data.url }
          : { error: extractedAttempt.error }),
      });
      extracted = extractedAttempt.ok
        ? extractedAttempt.data
        : {
            ok: true,
            url: tab.url,
            title: tab.title ?? null,
            text: "",
            truncated: false,
            media: null,
          };
    } else {
      const routed = await routeExtract({
        tabId: tab.id,
        url: tab.url,
        title: tab.title?.trim() ?? null,
        maxChars: settings.maxChars,
        minTextChars: 1,
        token: settings.token,
        noCache: Boolean(opts?.refresh),
        includeDiagnostics: settings.extendedLogging,
        signal: controller.signal,
        fetchImpl,
        extractFromTab,
        log: (event, detail) => {
          statusFromExtractEvent(event);
          logPanel(event, detail);
        },
      });
      if (isSuperseded()) return;
      logPanel(routed ? "extract:done" : "extract:failed", {
        ok: Boolean(routed),
        ...(routed
          ? { url: routed.extracted.url, source: routed.source }
          : { error: "No extractor result" }),
      });
      if (routed) {
        extracted = routed.extracted;
        routedResult = routed;
      } else {
        extracted = {
          ok: true,
          url: tab.url,
          title: tab.title ?? null,
          text: "",
          truncated: false,
          media: null,
        };
      }
    }
  }

  if (tab.url && extracted.url && !urlsMatch(tab.url, extracted.url)) {
    await new Promise((resolve) => setTimeout(resolve, 180));
    logPanel("extract:retry", { tabId: tab.id, maxChars: settings.maxChars });
    const retry = await extractFromTab(tab.id, settings.maxChars, {
      timeoutMs: 8_000,
      log: (event, detail) => logPanel(event, detail),
    });
    if (isSuperseded()) return;
    if (retry.ok) {
      extracted = retry.data;
      routedResult = null;
    }
  }

  const extractedMatchesTab = tab.url && extracted.url ? urlsMatch(tab.url, extracted.url) : true;
  const resolvedExtracted =
    tab.url && !extractedMatchesTab
      ? {
          ok: true,
          url: tab.url,
          title: tab.title ?? null,
          text: "",
          truncated: false,
          media: null,
        }
      : extracted;

  if (isSuperseded()) return;
  const resolvedTitle = tab.title?.trim() || resolvedExtracted.title || null;
  const resolvedPayload = { ...resolvedExtracted, title: resolvedTitle };
  const effectiveInputMode =
    opts?.inputMode ??
    (resolvedPayload.media?.hasVideo === true ||
    resolvedPayload.media?.hasAudio === true ||
    resolvedPayload.media?.hasCaptions === true ||
    (resolvedPayload.url && isYouTubeVideoUrl(resolvedPayload.url))
      ? "video"
      : undefined);
  const wordCount =
    resolvedPayload.text.length > 0 ? resolvedPayload.text.split(/\s+/).filter(Boolean).length : 0;
  const wantsSummaryTimestamps =
    settings.summaryTimestamps &&
    (effectiveInputMode === "video" ||
      resolvedPayload.media?.hasVideo === true ||
      resolvedPayload.media?.hasAudio === true ||
      resolvedPayload.media?.hasCaptions === true ||
      shouldPreferUrlMode(resolvedPayload.url));
  const wantsSlides =
    settings.slidesEnabled &&
    (effectiveInputMode === "video" ||
      resolvedPayload.media?.hasVideo === true ||
      shouldPreferUrlMode(resolvedPayload.url));
  const summaryTimestamps = wantsSummaryTimestamps || wantsSlides;

  logPanel("summarize:start", {
    reason,
    url: resolvedPayload.url,
    inputMode: effectiveInputMode ?? null,
    wantsSummaryTimestamps: summaryTimestamps,
    wantsSlides,
    wantsParallelSlides: false,
  });

  panelSessionStore.setCachedExtract(tab.id, {
    url: resolvedPayload.url,
    title: resolvedTitle,
    text: resolvedPayload.text,
    source: routedResult?.source ?? "page",
    truncated: resolvedPayload.truncated,
    totalCharacters: resolvedPayload.text.length,
    wordCount,
    media: resolvedPayload.media ?? null,
    transcriptSource: null,
    transcriptionProvider: null,
    transcriptCharacters: null,
    transcriptWordCount: null,
    transcriptLines: null,
    transcriptTimedText: null,
    mediaDurationSeconds: resolvedPayload.mediaDurationSeconds ?? null,
    slides: null,
    diagnostics: routedResult?.diagnostics ?? null,
  });

  sendStatus("Connecting…");
  session.inflightUrl = resolvedPayload.url;
  const slidesConfig = wantsSlides
    ? {
        enabled: true as const,
        ocr: settings.slidesOcrEnabled,
        maxSlides: null,
        minDurationSeconds: null,
      }
    : { enabled: false as const };
  const summarySlides = slidesConfig;

  let id: string;
  try {
    const body = buildSummarizeRequestBody({
      extracted: resolvedPayload,
      settings,
      noCache: Boolean(opts?.refresh),
      inputMode: effectiveInputMode,
      timestamps: summaryTimestamps,
      slides: summarySlides,
    });
    logPanel("summarize:request", {
      url: resolvedPayload.url,
      slides: wantsSlides,
      slidesParallel: false,
      timestamps: summaryTimestamps,
    });
    const res = await fetchImpl("http://127.0.0.1:8787/v1/summarize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.token.trim()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json()) as { ok: boolean; id?: string; error?: string };
    if (isSuperseded()) return;
    if (!res.ok || !json.ok || !json.id) {
      throw new Error(json.error || `${res.status} ${res.statusText}`);
    }
    session.daemonStatus.markReady();
    id = json.id;
  } catch (err) {
    if (isSuperseded()) return;
    const message = friendlyFetchError(err, "Daemon request failed");
    send({ type: "run:error", message });
    sendStatus(`Error: ${message}`);
    session.inflightUrl = null;
    if (!isManual && isDaemonUnreachableError(err)) {
      session.daemonRecovery.recordFailure(resolvedPayload.url);
    }
    return;
  }

  send({
    type: "run:start",
    run: {
      id,
      url: resolvedPayload.url,
      title: resolvedTitle,
      model: settings.model,
      reason,
      slides: wantsSlides,
    },
  });
}
