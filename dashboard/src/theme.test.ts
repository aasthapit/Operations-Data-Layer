import { describe, expect, it, vi } from "vitest";
import {
  COLOR_MODE_KEY, applyColorMode, createAppTheme, readColorModePreference, resolveColorMode,
  statusColor, systemColorMode, writeColorModePreference,
} from "./theme";

describe("the palette", () => {
  it("carries the fleet's own vocabulary in both modes", () => {
    for (const mode of ["dark", "light"] as const) {
      const theme = createAppTheme(mode);
      expect(theme.palette.mode).toBe(mode);
      // every health word has a colour to write in and a tint to sit on
      for (const tone of ["healthy", "warning", "critical", "unknown"] as const) {
        expect(theme.palette.status[tone].main).toMatch(/^#/);
        expect(theme.palette.status[tone].surface).toMatch(/^rgba\(/);
      }
      // and the three MUI slots that mean the same thing agree with them
      expect(theme.palette.success.main).toBe(theme.palette.status.healthy.main);
      expect(theme.palette.warning.main).toBe(theme.palette.status.warning.main);
      expect(theme.palette.error.main).toBe(theme.palette.status.critical.main);
    }
  });

  it("offers eight categorical slots, and they are not the status colours", () => {
    const { palette } = createAppTheme("dark");
    expect(palette.chart.series).toHaveLength(8);
    expect(new Set(palette.chart.series).size).toBe(8);
    expect(palette.chart.line).toBe(palette.primary.main);
    for (const tone of ["healthy", "warning", "critical"] as const) {
      expect(palette.chart.series).not.toContain(palette.status[tone].main);
    }
  });

  it("is a different palette in each mode", () => {
    expect(createAppTheme("dark").palette.background.paper)
      .not.toBe(createAppTheme("light").palette.background.paper);
  });

  it("answers for a status it has never heard of", () => {
    const theme = createAppTheme("dark");
    expect(statusColor(theme, "critical")).toBe(theme.palette.status.critical);
    expect(statusColor(theme, "phase-of-the-moon")).toBe(theme.palette.status.unknown);
    expect(statusColor(theme, null)).toBe(theme.palette.status.unknown);
  });

  it("keeps the app's own density and shape", () => {
    const theme = createAppTheme("dark");
    expect(theme.shape.borderRadius).toBe(10);
    expect(theme.typography.fontSize).toBe(14);
    expect(theme.components?.MuiButton?.defaultProps?.size).toBe("small");
    expect(theme.components?.MuiTextField?.defaultProps?.size).toBe("small");
  });
});

describe("choosing a mode", () => {
  it("follows the OS until somebody says otherwise", () => {
    expect(readColorModePreference()).toBe("system");
    const light = vi.fn(() => ({ matches: true }) as MediaQueryList);
    vi.stubGlobal("matchMedia", light);
    expect(systemColorMode()).toBe("light");
    expect(resolveColorMode("system")).toBe("light");
    // an explicit choice wins over the OS
    expect(resolveColorMode("dark")).toBe("dark");
  });

  it("falls back to dark where the OS cannot be asked", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(systemColorMode()).toBe("dark");
  });

  it("remembers a choice, and reads the document when nothing is stored", () => {
    writeColorModePreference("light");
    expect(window.localStorage.getItem(COLOR_MODE_KEY)).toBe("light");
    expect(readColorModePreference()).toBe("light");

    window.localStorage.clear();
    applyColorMode("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(readColorModePreference()).toBe("dark");
  });

  it("survives a browser that refuses storage", () => {
    const boom = () => { throw new Error("storage disabled"); };
    vi.spyOn(window.localStorage, "getItem").mockImplementation(boom);
    vi.spyOn(window.localStorage, "setItem").mockImplementation(boom);
    expect(() => writeColorModePreference("dark")).not.toThrow();
    expect(readColorModePreference()).toBe("system");
  });
});
