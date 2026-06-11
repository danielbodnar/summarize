// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { createTypographyController } from "../apps/chrome-extension/src/entrypoints/sidepanel/typography-controller.js";

function createController() {
  const sizeSmBtn = document.createElement("button");
  const sizeLgBtn = document.createElement("button");
  const lineTightBtn = document.createElement("button");
  const lineLooseBtn = document.createElement("button");
  return createTypographyController({
    sizeSmBtn,
    sizeLgBtn,
    lineTightBtn,
    lineLooseBtn,
    defaultFontSize: 15,
    defaultLineHeight: 1.5,
  });
}

describe("sidepanel typography controller", () => {
  it("applies typography vars and clamps values", () => {
    const controller = createController();

    controller.apply("IBM Plex Sans", 17, 1.6);

    expect(document.documentElement.style.getPropertyValue("--font-body")).toBe("IBM Plex Sans");
    expect(document.documentElement.style.getPropertyValue("--font-size")).toBe("17px");
    expect(document.documentElement.style.getPropertyValue("--line-height")).toBe("1.6");
    expect(controller.clampFontSize(99)).toBe(20);
    expect(controller.clampLineHeight(0.5)).toBe(1.2);
  });

  it("tracks current values through button-state updates", () => {
    const controller = createController();

    controller.setCurrentFontSize(11);
    controller.setCurrentLineHeight(2.1);

    expect(controller.getCurrentFontSize()).toBe(12);
    expect(controller.getCurrentLineHeight()).toBe(1.9);
  });
});
