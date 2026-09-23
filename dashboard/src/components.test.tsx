import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Dot, Empty, ErrorBanner, ErrorBoundary, FilterSelect, HealthBar, Loading, Pill, SearchInput,
  Skeleton, SkeletonLines, SkeletonStats, SkeletonTable, Sparkline, Stat, SubTabs, Tier, UsageBar,
  fmtAge, fmtBytes, fmtCores, fmtDate, fmtDays, fmtPct, fmtTime,
} from "./components";
import { closestElement, renderThemed } from "./test/harness";

describe("formatters", () => {
  it("reads CPU in cores above one and in millicores below it", () => {
    expect(fmtCores(6.021)).toBe("6.02 cores");
    expect(fmtCores(1)).toBe("1.00 cores");
    expect(fmtCores(0.25)).toBe("250m");
    expect(fmtCores(0.0055)).toBe("5.5m");
    expect(fmtCores(null)).toBe("—");
  });

  it("reads memory in the largest binary unit it fills", () => {
    expect(fmtBytes(12884901888)).toBe("12.0 GiB");
    expect(fmtBytes(536870912)).toBe("512 MiB");
    expect(fmtBytes(4096)).toBe("4 KiB");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(null)).toBe("—");
  });

  it("reads a percentage to one decimal place", () => {
    expect(fmtPct(88.44)).toBe("88.4%");
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(null)).toBe("—");
  });

  it("formats a timestamp and a date, and says nothing for a missing one", () => {
    expect(fmtTime("2026-09-20T20:58:02+00:00")).toContain("2026");
    expect(fmtDate("2026-09-20T20:58:02+00:00")).toContain("2026");
    expect(fmtTime(null)).toBe("—");
    expect(fmtDate(null)).toBe("—");
  });

  it("reads an age in the largest unit that still has a number in front of it", () => {
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
    expect(fmtAge(ago(30))).toBe("1m");
    expect(fmtAge(ago(600))).toBe("10m");
    expect(fmtAge(ago(7200))).toBe("2h");
    expect(fmtAge(ago(3 * 86400))).toBe("3d");
    expect(fmtAge(null)).toBe("—");
  });

  it("says an expired certificate expired rather than showing a negative day count", () => {
    expect(fmtDays(12.4)).toBe("12d");
    expect(fmtDays(-4)).toBe("expired 4d ago");
    expect(fmtDays(null)).toBe("—");
  });
});

describe("status chrome", () => {
  it("names the status on the pill and falls back to unknown", () => {
    const { rerender } = renderThemed(<Pill status="critical" />);
    expect(closestElement(screen.getByText("critical"), "[data-status]"))
      .toHaveAttribute("data-status", "critical");
    rerender(<Pill status={null} />);
    expect(closestElement(screen.getByText("unknown"), "[data-status]"))
      .toHaveAttribute("data-status", "unknown");
  });

  it("gives the dot the status as a data attribute", () => {
    const { container, rerender } = renderThemed(<Dot status="warning" />);
    expect(container.firstChild).toHaveAttribute("data-status", "warning");
    rerender(<Dot status={null} />);
    expect(container.firstChild).toHaveAttribute("data-status", "unknown");
  });

  it("marks a critical tier and says nothing for a namespace that has none", () => {
    const { rerender } = renderThemed(<Tier tier="critical" />);
    // the tier is the chip's own property, and only "critical" is coloured
    expect(closestElement(screen.getByText("critical"), "[data-tier]"))
      .toHaveAttribute("data-tier", "critical");
    rerender(<Tier tier="standard" />);
    expect(closestElement(screen.getByText("standard"), "[data-tier]"))
      .toHaveAttribute("data-tier", "standard");
    rerender(<Tier tier={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("draws the health bar in the fleet's own order, leaving out the empty bands", () => {
    renderThemed(<HealthBar counts={{ healthy: 2, warning: 1, critical: 1, unknown: 0 }} />);
    // the breakdown is the bar's accessible name as well as its tooltip, so a
    // bar nobody can hover still says what it is made of
    const bar = screen.getByLabelText("healthy: 2 warning: 1 critical: 1 unknown: 0");
    const bands = [...bar.children];
    expect(bands.map((b) => b.getAttribute("data-status")))
      .toEqual(["healthy", "warning", "critical"]);
    expect(bands[0]).toHaveStyle({ width: "50%" });
  });

  it("draws a usage bar with a tone for the threshold it has crossed", () => {
    const tone = (percent: number) => {
      const { container, unmount } = renderThemed(<UsageBar percent={percent} />);
      // the bar's fill has no role or name of its own - the threshold it has
      // crossed is what it carries, so the DOM shape is the point here
      const tone = container.querySelector("[data-tone]")?.getAttribute("data-tone");
      unmount();
      return tone;
    };
    expect(tone(41.2)).toBe("healthy");
    expect(tone(88.4)).toBe("warning");
    expect(tone(96.5)).toBe("critical");
  });

  it("says usage is not available rather than drawing an empty bar", () => {
    renderThemed(<UsageBar percent={null} />);
    expect(screen.getByText("n/a")).toBeInTheDocument();
  });

  it("caps the filled part of the bar at the width of the bar", () => {
    const { container } = renderThemed(<UsageBar percent={140} label="CPU" />);
    expect(container.querySelector("[data-tone]")).toHaveStyle({ width: "100%" });
    expect(screen.getByText("140%")).toBeInTheDocument();
  });
});

describe("stats and sparklines", () => {
  it("draws a label, a value and the sub-line under it", () => {
    renderThemed(<Stat label="Clusters" value={5} kind="accent" sub="2 upgrading" />);
    expect(screen.getByText("Clusters")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("2 upgrading")).toBeInTheDocument();
  });

  it("is clickable only when the view gave it somewhere to go", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderThemed(<Stat label="Healthy" value={2} onClick={onClick} />);
    // a tile that goes somewhere is a button, so a keyboard reaches it too
    expect(screen.getByRole("button", { name: /Healthy/ })).toBeInTheDocument();
    await user.click(screen.getByText("Healthy"));
    expect(onClick).toHaveBeenCalled();
    rerender(<Stat label="Healthy" value={2} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("draws a sparkline over the points it was given", () => {
    const { container } = renderThemed(<Sparkline points={[10, 40, 25]} width={100} height={20} />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[1]).toHaveAttribute("d", "M0.0,18.0 L50.0,12.0 L100.0,15.0");
  });

  it("says there is no history rather than drawing an empty chart", () => {
    renderThemed(<Sparkline points={[]} />);
    expect(screen.getByText("no history")).toBeInTheDocument();
  });

  it("draws a single point without dividing by zero", () => {
    const { container } = renderThemed(<Sparkline points={[50]} width={100} height={20} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("placeholders", () => {
  it("draws a block the shape of the content that will replace it", () => {
    const { container } = renderThemed(<Skeleton width="60%" height={11} />);
    expect(container.firstChild).toHaveStyle({ width: "60%", height: "11px" });
  });

  it("draws the right number of pending rows, cells, stats and lines", () => {
    const { container: table } = renderThemed(<SkeletonTable columns={3} rows={4} dense />);
    expect(table.querySelectorAll("tr")).toHaveLength(4);
    expect(table.querySelectorAll("td")).toHaveLength(12);
    // a placeholder is scenery: it is not read out and it is not a table
    expect(table.querySelector("table")).toHaveAttribute("aria-hidden", "true");

    const { container: stats } = renderThemed(<SkeletonStats count={6} />);
    expect(stats.firstChild?.childNodes).toHaveLength(6);

    const { container: lines } = renderThemed(<SkeletonLines rows={3} />);
    expect(lines.firstChild?.childNodes).toHaveLength(3);
  });

  it("says it is loading", () => {
    renderThemed(<Loading />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});

describe("SearchInput", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("reports once the user stops typing rather than once per keystroke", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderThemed(<SearchInput value="" onChange={onChange} aria-label="Filter images" />);
    await user.type(screen.getByLabelText("Filter images"), "quay");
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith("quay"));
  });

  it("takes a new value from outside without reporting it straight back", async () => {
    const onChange = vi.fn();
    const { rerender } = renderThemed(
      <SearchInput value="quay" onChange={onChange} aria-label="Filter images" />);
    const box = screen.getByLabelText("Filter images");
    expect(box).toHaveValue("quay");
    // The filter was cleared elsewhere - by the view's own Clear button, or by
    // the back button walking out of the filtered URL.
    rerender(<SearchInput value="" onChange={onChange} aria-label="Filter images" />);
    expect(box).toHaveValue("");
    vi.advanceTimersByTime(400);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports an emptied box, so clearing it in place clears the filter", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderThemed(<SearchInput value="quay" onChange={onChange} aria-label="Filter images" />);
    await user.clear(screen.getByLabelText("Filter images"));
    vi.advanceTimersByTime(300);
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith(""));
  });
});

describe("small controls", () => {
  it("marks the active sub-tab and reports the one that was chosen", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderThemed(<SubTabs tabs={[["overview", "Overview", 3], ["nodes", "Nodes"]]}
      value="overview" onChange={onChange} />);
    expect(screen.getByRole("button", { name: /Overview/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Overview/ })).toHaveTextContent("Overview3");
    await user.click(screen.getByRole("button", { name: "Nodes" }));
    expect(onChange).toHaveBeenCalledWith("nodes");
  });

  it("offers every option plus the all-entry, and reports what was picked", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderThemed(<FilterSelect label="Hub" value="" options={["hub-east", "hub-west"]}
      onChange={onChange} />);
    const select = screen.getByLabelText("Hub") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent))
      .toEqual(["All", "hub-east", "hub-west"]);
    await user.selectOptions(select, "hub-west");
    expect(onChange).toHaveBeenCalledWith("hub-west");
  });

  it("uses the caller's own word for the all-entry", () => {
    renderThemed(<FilterSelect label="Kind" value="routes" options={["routes"]} onChange={() => {}}
      allLabel="routes" />);
    expect(screen.getAllByText("routes")).toHaveLength(2);
  });
});

describe("error chrome", () => {
  it("shows an error's message and nothing at all when there is none", () => {
    const { rerender, container } = renderThemed(<ErrorBanner error={new Error("404 Not Found")} />);
    expect(screen.getByText("Error: 404 Not Found")).toBeInTheDocument();
    rerender(<ErrorBanner error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a string error as it is", () => {
    renderThemed(<ErrorBanner error="No schema." />);
    expect(screen.getByText("Error: No schema.")).toBeInTheDocument();
  });

  it("draws the empty state it was given", () => {
    renderThemed(<Empty>Run a query to see the impact.</Empty>);
    expect(screen.getByText("Run a query to see the impact.")).toBeInTheDocument();
  });
});

describe("ErrorBoundary", () => {
  function Boom({ fail }: { fail?: boolean }) {
    if (fail) throw new Error("Cannot read properties of undefined (reading 'cpu')");
    return <div>the view</div>;
  }

  it("shows what broke instead of blanking the app, and offers a way back", async () => {
    const onReset = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // React re-throws the caught error so the page's own handlers see it; jsdom
    // would print that as an uncaught error in the middle of a passing run.
    const swallow = (e: ErrorEvent) => e.preventDefault();
    window.addEventListener("error", swallow);
    const user = userEvent.setup();
    renderThemed(<ErrorBoundary onReset={onReset}><Boom fail /></ErrorBoundary>);
    expect(screen.getByText("This view failed to render")).toBeInTheDocument();
    expect(screen.getByText(/reading 'cpu'/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to overview" })).toHaveAttribute("href", "/");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReset).toHaveBeenCalled();
    window.removeEventListener("error", swallow);
    error.mockRestore();
  });

  it("stays out of the way while the view renders", () => {
    renderThemed(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText("the view")).toBeInTheDocument();
  });
});
