import { parseHtmlDocument } from "../../html-document.js";

export type DetectedVideo = {
  kind: "youtube" | "direct";
  url: string;
};

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".m3u8"]);

function resolveAbsoluteUrl(candidate: string, baseUrl: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

function isDirectVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const lower = parsed.pathname.toLowerCase();
    for (const ext of VIDEO_EXTENSIONS) {
      if (lower.endsWith(ext)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function extractYouTubeVideoIdFromEmbedUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (
      host === "youtube.com" ||
      host.endsWith(".youtube.com") ||
      host === "youtube-nocookie.com" ||
      host.endsWith(".youtube-nocookie.com")
    ) {
      const m = u.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
      return m?.[1] ?? null;
    }
    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").trim();
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

function metaContent(
  document: Document,
  selectors: Array<{ attribute: "property" | "name"; value: string }>,
): string | null {
  for (const sel of selectors) {
    const meta = document.querySelector(`meta[${sel.attribute}="${sel.value}"]`);
    if (!meta) continue;
    const value = (meta.getAttribute("content") ?? meta.getAttribute("value") ?? "").trim();
    if (value) return value;
  }
  return null;
}

export function detectPrimaryVideoFromHtml(html: string, url: string): DetectedVideo | null {
  const parsed = parseHtmlDocument(html);
  const { document } = parsed;

  try {
    // 1) YouTube embeds (preferred, stable)
    const iframeSrc =
      document
        .querySelector(
          'iframe[src*="youtube.com/embed/"], iframe[src*="youtube-nocookie.com/embed/"], iframe[src*="youtu.be/"]',
        )
        ?.getAttribute("src") ?? null;
    if (iframeSrc) {
      const resolved = resolveAbsoluteUrl(iframeSrc, url);
      const videoId = resolved ? extractYouTubeVideoIdFromEmbedUrl(resolved) : null;
      if (videoId) {
        return { kind: "youtube", url: `https://www.youtube.com/watch?v=${videoId}` };
      }
    }

    // 2) OpenGraph video
    const ogVideo = metaContent(document, [
      { attribute: "property", value: "og:video" },
      { attribute: "property", value: "og:video:url" },
      { attribute: "property", value: "og:video:secure_url" },
      { attribute: "name", value: "og:video" },
      { attribute: "name", value: "og:video:url" },
      { attribute: "name", value: "og:video:secure_url" },
    ]);
    if (ogVideo) {
      const resolved = resolveAbsoluteUrl(ogVideo, url);
      if (resolved && isDirectVideoUrl(resolved)) {
        return { kind: "direct", url: resolved };
      }
      const ytId = resolved ? extractYouTubeVideoIdFromEmbedUrl(resolved) : null;
      if (ytId) return { kind: "youtube", url: `https://www.youtube.com/watch?v=${ytId}` };
    }

    // 3) <video> tags
    const videoSrc =
      document.querySelector("video[src]")?.getAttribute("src") ??
      document.querySelector("video source[src]")?.getAttribute("src") ??
      null;
    if (videoSrc) {
      const resolved = resolveAbsoluteUrl(videoSrc, url);
      if (resolved && isDirectVideoUrl(resolved)) {
        return { kind: "direct", url: resolved };
      }
    }

    return null;
  } finally {
    parsed.close();
  }
}
