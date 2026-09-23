import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Dot, Empty, ErrorBanner, ErrorBoundary, FilterSelect, HealthBar, Loading, Pill, SearchInput,
  Skeleton, SkeletonLines, SkeletonStats, SkeletonTable, Sparkline, Stat, SubTabs, Tier, UsageBar,
  fmtAge, fmtBytes, fmtCores, fmtDate, fmtDays, fmtPct, fmtTime,
} from "./components";

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
    const { rerender } = render(<Pill status="critical" />);
    expect(screen.getByText("critical")).toHaveClass("pill", "critical");
    rerender(<Pill status={null} />);
    expect(screen.getByText("unknown")).toHaveClass("pill", "unknown");
  });

  it("gives the dot the status as its class", () => {
    const { container, rerender } = render(<Dot status="warning" />);
    expect(container.firstChild).toHaveClass("dot-s", "warning");
    rerender(<Dot status={null} />);
    expect(container.firstChild).toHaveClass("unknown");
  });

  it("marks a critical tier and says nothing for a namespace that has none", () => {
    const { rerender } = render(<Tier tier="critical" />);
    expect(screen.getByText("critical")).toHaveClass("tag", "critical");
    rerender(<Tier tier="standard" />);
    expect(screen.getByText("standard")).toHaveClass("tag");
    rerender(<Tier tier={null} />);
    expect(screen.getByText("—")).toHaveClass("muted");
  });

  it("draws the health bar in the fleet's own order, leaving out the empty bands", () => {
    const { container } = render(
      <HealthBar counts={{ healthy: 2, warning: 1, critical: 1, unknown: 0 }} />);
    expect(container.firstChild).toHaveAttribute("title",
      "healthy: 2  warning: 1  critical: 1  unknown: 0");
    const bands = [...(container.firstChild as HTMLElement).children];
    expect(bands.map((b) => b.className)).toEqual(["healthy", "warning", "critical"]);
    expect(bands[0]).toHaveStyle({ width: "50%" });
  });

  it("draws a usage bar with a tone for the threshold it has crossed", () => {
    const tone = (percent: number) => {
      const { container, unmount } = render(<UsageBar percent={percent} />);
      // the bar's fill has no role or name of its own - the class is what the
      // threshold is expressed in, so the DOM shape is the point here
      const fill = container.querySelector(".usage-bar > span") as HTMLElement;
      const { className } = fill;
      unmount();
      return className;
    };
    expect(tone(41.2)).toBe("healthy");
    expect(tone(88.4)).toBe("warning");
    expect(tone(96.5)).toBe("critical");
  });

  it("says usage is not available rather than drawing an empty bar", () => {
    render(<UsageBar percent={null} />);
    expect(screen.getByText("n/a")).toBeInTheDocument();
  });

  it("caps the filled part of the bar at the width of the bar", () => {
    const { container } = render(<UsageBar percent={140} label="CPU" />);
    expect(container.querySelector(".usage-bar > span")).toHaveStyle({ width: "100%" });
    expect(screen.getByText("140%")).toBeInTheDocument();
  });
});

describe("stats and sparklines", () => {
  it("draws a label, a value and the sub-line under it", () => {
    render(<Stat label="Clusters" value={5} kind="accent" sub="2 upgrading" />);
    expect(screen.getByText("Clusters")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("2 upgrading")).toBeInTheDocument();
  });

  it("is clickable only when the view gave it somewhere to go", async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    const { container, rerender } = render(<Stat label="Healthy" value={2} onClick={onClick} />);
    expect(container.firstChild).toHaveClass("clickable");
    await user.click(screen.getByText("Healthy"));
    expect(onClick).toHaveBeenCalled();
    rerender(<Stat label="Healthy" value={2} />);
    expect(container.firstChild).not.toHaveClass("clickable");
  });

  it("draws a sparkline over the points it was given", () => {
    const { container } = render(<Sparkline points={[10, 40, 25]} width={100} height={20} />);
    const paths = container.querySelectorAll("path");
    expect(paths).toHaveLength(2);
    expect(paths[1]).toHaveAttribute("d", "M0.0,18.0 L50.0,12.0 L100.0,15.0");
  });

  it("says there is no history rather than drawing an empty chart", () => {
    render(<Sparkline points={[]} />);
    expect(screen.getByText("no history")).toBeInTheDocument();
  });

  it("draws a single point without dividing by zero", () => {
    const { container } = render(<Sparkline points={[50]} width={100} height={20} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("placeholders", () => {
  it("draws a block the shape of the content that will replace it", () => {
    const { container } = render(<Skeleton width="60%" height={11} />);
    expect(container.firstChild).toHaveClass("skeleton");
    expect(container.firstChild).toHaveStyle({ width: "60%", height: "11px" });
  });

  it("draws the right number of pending rows, cells, stats and lines", () => {
    const { container: table } = render(<SkeletonTable columns={3} rows={4} dense />);
    expect(table.querySelectorAll("tr")).toHaveLength(4);
    expect(table.querySelectorAll("td")).toHaveLength(12);
    expect(table.querySelector("table")).toHaveClass("dt-dense");
    expect(table.querySelector("table")).toHaveAttribute("aria-hidden", "true");

    const { container: stats } = render(<SkeletonStats count={6} />);
    expect(stats.querySelectorAll(".stat")).toHaveLength(6);

    const { container: lines } = render(<SkeletonLines rows={3} />);
    expect(lines.querySelectorAll(".skeleton")).toHaveLength(3);
  });

  it("says it is loading", () => {
    render(<Loading />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });
});

describe("SearchInput", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("reports once the user stops typing rather than once per keystroke", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<SearchInput value="" onChange={onChange} aria-label="Filter images" />);
    await user.type(screen.getByLabelText("Filter images"), "quay");
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith("quay"));
  });

  it("takes a new value from outside without reporting it straight back", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
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
    render(<SearchInput value="quay" onChange={onChange} aria-label="Filter images" />);
    await user.clear(screen.getByLabelText("Filter images"));
    vi.advanceTimersByTime(300);
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith(""));
  });
});

describe("small controls", () => {
  it("marks the active sub-tab and reports the one that was chosen", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SubTabs tabs={[["overview", "Overview", 3], ["nodes", "Nodes"]]}
      value="overview" onChange={onChange} />);
    expect(screen.getByRole("button", { name: /Overview/ })).toHaveClass("active");
    expect(screen.getByText("3")).toHaveClass("count");
    await user.click(screen.getByRole("button", { name: "Nodes" }));
    expect(onChange).toHaveBeenCalledWith("nodes");
  });

  it("offers every option plus the all-entry, and reports what was picked", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<FilterSelect label="Hub" value="" options={["hub-east", "hub-west"]}
      onChange={onChange} />);
    const select = screen.getByLabelText("Hub") as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent))
      .toEqual(["All", "hub-east", "hub-west"]);
    await user.selectOptions(select, "hub-west");
    expect(onChange).toHaveBeenCalledWith("hub-west");
  });

  it("uses the caller's own word for the all-entry", () => {
    render(<FilterSelect label="Kind" value="routes" options={["routes"]} onChange={() => {}}
      allLabel="routes" />);
    expect(screen.getAllByText("routes")).toHaveLength(2);
  });
});

describe("error chrome", () => {
  it("shows an error's message and nothing at all when there is none", () => {
    const { rerender, container } = render(<ErrorBanner error={new Error("404 Not Found")} />);
    expect(screen.getByText("Error: 404 Not Found")).toBeInTheDocument();
    rerender(<ErrorBanner error={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a string error as it is", () => {
    render(<ErrorBanner error="No schema." />);
    expect(screen.getByText("Error: No schema.")).toBeInTheDocument();
  });

  it("draws the empty state it was given", () => {
    render(<Empty>Run a query to see the impact.</Empty>);
    expect(screen.getByText("Run a query to see the impact.")).toHaveClass("empty");
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
    render(<ErrorBoundary onReset={onReset}><Boom fail /></ErrorBoundary>);
    expect(screen.getByText("This view failed to render")).toBeInTheDocument();
    expect(screen.getByText(/reading 'cpu'/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to overview" })).toHaveAttribute("href", "/");
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onReset).toHaveBeenCalled();
    window.removeEventListener("error", swallow);
    error.mockRestore();
  });

  it("stays out of the way while the view renders", () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText("the view")).toBeInTheDocument();
  });
});
