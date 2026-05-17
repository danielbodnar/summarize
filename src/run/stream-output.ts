export type StreamOutputMode = "line" | "delta";

function terminalColumns(stream: NodeJS.WritableStream): number {
  const columns = (stream as unknown as { columns?: unknown }).columns;
  return typeof columns === "number" && Number.isFinite(columns) && columns > 0
    ? Math.floor(columns)
    : 80;
}

function terminalRows(stream: NodeJS.WritableStream): number {
  const rows = (stream as unknown as { rows?: unknown }).rows;
  return typeof rows === "number" && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;
}

function displayCellWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function visualLineCount(text: string, columns: number): number {
  let lines = 1;
  let column = 0;
  for (const char of text.replace(/\r\n?/g, "\n")) {
    if (char === "\n") {
      lines += 1;
      column = 0;
      continue;
    }
    column += displayCellWidth(char);
    if (column > columns) {
      lines += 1;
      column = displayCellWidth(char);
    }
  }
  return lines;
}

function rewindPrintedLines(lines: number): string {
  let sequence = "\r\u001b[2K";
  for (let i = 1; i < lines; i += 1) {
    sequence += "\u001b[1A\r\u001b[2K";
  }
  return sequence;
}

export function createStreamOutputGate({
  stdout,
  clearProgressForStdout,
  restoreProgressAfterStdout,
  outputMode,
  richTty,
  rewriteOnReplacement = false,
  restoreDuringStream = true,
}: {
  stdout: NodeJS.WritableStream;
  clearProgressForStdout: () => void;
  restoreProgressAfterStdout?: (() => void) | null;
  outputMode: StreamOutputMode;
  richTty: boolean;
  rewriteOnReplacement?: boolean;
  restoreDuringStream?: boolean;
}) {
  let cleared = false;
  let plainFlushedLen = 0;
  let plainLeadingSkipLen = 0;
  let plainFlushedText = "";
  let pendingFinalReprint: string | null = null;
  const columns = terminalColumns(stdout);
  const rows = terminalRows(stdout);

  const ensureCleared = () => {
    if (cleared) return;
    clearProgressForStdout();
    if (richTty) stdout.write("\n");
    cleared = true;
  };

  const clearBeforeWrite = () => {
    if (restoreDuringStream) clearProgressForStdout();
  };

  const flush = (text: string) => {
    clearBeforeWrite();
    stdout.write(text);
    plainFlushedText += text;
    if (restoreDuringStream) restoreProgressAfterStdout?.();
  };

  const handleChunk = (streamed: string, prevStreamed: string) => {
    if (pendingFinalReprint !== null) {
      pendingFinalReprint = streamed;
      return;
    }

    if (plainFlushedLen === 0) {
      const match = streamed.match(/^\n+/);
      if (match) {
        plainLeadingSkipLen = match[0].length;
        plainFlushedLen = match[0].length;
      }
    }

    if (outputMode === "line") {
      const lastNl = streamed.lastIndexOf("\n");
      if (lastNl >= 0 && lastNl + 1 > plainFlushedLen) {
        ensureCleared();
        flush(streamed.slice(plainFlushedLen, lastNl + 1));
        plainFlushedLen = lastNl + 1;
      }
      return;
    }

    const isAppendOnly = streamed.startsWith(prevStreamed);
    if (streamed.length > plainFlushedLen && isAppendOnly) {
      ensureCleared();
      flush(streamed.slice(plainFlushedLen));
      plainFlushedLen = streamed.length;
      return;
    }
    if (!isAppendOnly) {
      ensureCleared();
      if (rewriteOnReplacement && plainFlushedLen > 0) {
        const replacement = streamed.slice(plainLeadingSkipLen);
        const printedLines = visualLineCount(plainFlushedText, columns);
        if (printedLines > rows) {
          // Cursor-up cannot reach scrolled-off terminal history; avoid replaying over a partial viewport.
          pendingFinalReprint = streamed;
          return;
        }
        if (restoreDuringStream) clearProgressForStdout();
        stdout.write(`${rewindPrintedLines(printedLines)}${replacement}`);
        if (restoreDuringStream) restoreProgressAfterStdout?.();
        plainFlushedLen = streamed.length;
        plainFlushedText = replacement;
        return;
      }
      plainFlushedText = "";
      flush(streamed);
      plainFlushedLen = streamed.length;
    }
  };

  const finalize = (finalText: string) => {
    if (pendingFinalReprint !== null) {
      const corrected = finalText || pendingFinalReprint;
      let reprint = plainFlushedText && !plainFlushedText.endsWith("\n") ? "\n" : "";
      reprint += corrected.replace(/^\n+/, "");
      if (!reprint.endsWith("\n")) reprint += "\n";
      clearBeforeWrite();
      stdout.write(reprint);
      restoreProgressAfterStdout?.();
      plainFlushedLen = finalText.length;
      plainFlushedText += reprint;
      pendingFinalReprint = null;
      return;
    }

    const remaining = plainFlushedLen < finalText.length ? finalText.slice(plainFlushedLen) : "";
    if (remaining) {
      clearBeforeWrite();
      stdout.write(remaining);
      plainFlushedText += remaining;
      restoreProgressAfterStdout?.();
    }
    const endedWithNewline = remaining
      ? remaining.endsWith("\n")
      : plainFlushedLen > 0 && finalText[plainFlushedLen - 1] === "\n";
    if (!endedWithNewline) {
      clearBeforeWrite();
      stdout.write("\n");
      plainFlushedText += "\n";
      restoreProgressAfterStdout?.();
    }
  };

  return { handleChunk, finalize, getFlushedLen: () => plainFlushedLen };
}
