// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMetricsController } from "../apps/chrome-extension/src/entrypoints/sidepanel/metrics-controller.js";

class MockResizeObserver {
  observe() {}
}

describe("sidepanel metrics controller", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
  });

  it("renders summary metrics in the home slot", () => {
    const metricsEl = document.createElement("div");
    const metricsHomeEl = document.createElement("div");
    const chatMetricsSlotEl = document.createElement("div");
    document.body.append(metricsHomeEl, chatMetricsSlotEl);
    metricsHomeEl.append(metricsEl);

    const controller = createMetricsController({
      metricsEl: metricsEl as HTMLDivElement,
      metricsHomeEl: metricsHomeEl as HTMLDivElement,
      chatMetricsSlotEl: chatMetricsSlotEl as HTMLDivElement,
    });

    controller.setForMode(
      "summary",
      "12m YouTube · 1.2k words",
      null,
      "https://youtube.com/watch?v=test",
    );
    controller.setActiveMode("summary");

    expect(metricsHomeEl.contains(metricsEl)).toBe(true);
    expect(metricsEl.textContent).toContain("12m");
    expect(metricsEl.textContent).toContain("YouTube");
    expect(metricsEl.classList.contains("hidden")).toBe(false);
  });

  it("moves chat metrics into the chat slot and toggles visibility", () => {
    const metricsEl = document.createElement("div");
    const metricsHomeEl = document.createElement("div");
    const chatMetricsSlotEl = document.createElement("div");
    document.body.append(metricsHomeEl, chatMetricsSlotEl);
    metricsHomeEl.append(metricsEl);

    const controller = createMetricsController({
      metricsEl: metricsEl as HTMLDivElement,
      metricsHomeEl: metricsHomeEl as HTMLDivElement,
      chatMetricsSlotEl: chatMetricsSlotEl as HTMLDivElement,
    });

    controller.setForMode("chat", "Cached · example.com", null, null);
    controller.setActiveMode("chat");

    expect(chatMetricsSlotEl.contains(metricsEl)).toBe(true);
    expect(chatMetricsSlotEl.classList.contains("isVisible")).toBe(true);

    controller.clearForMode("chat");
    controller.setActiveMode("chat");

    expect(metricsEl.textContent).toBe("");
    expect(metricsEl.classList.contains("hidden")).toBe(true);
    expect(chatMetricsSlotEl.classList.contains("isVisible")).toBe(false);
  });
});
