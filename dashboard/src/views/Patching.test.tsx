import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Patching from "./Patching";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { closestElement, currentUrl, parentOf, renderView } from "../test/harness";
import { PATCH_JOB, PATCH_JOBS, PATCH_REPORT } from "../test/fixtures/platform";

vi.mock("../api", async () => {
  const { createApiMock } = await import("../test/apiMock");
  return { api: createApiMock(), BASE: "" };
});
// why: `vi.mock` above replaced the module, so what this hands back is the
// table-backed stand-in rather than the real client.
const { api } = await import("../api") as unknown as { api: ApiMock };

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidate();
  answer(api, { patchReport: PATCH_REPORT, patchJobs: PATCH_JOBS, patchJob: PATCH_JOB });
});

const open = (at = "/patching", id?: string) => renderView(
  ({ nav }) => <Patching id={id} nav={nav} />, { at });

describe("the report", () => {
  it("counts the jobs, the ones that finished and the ones that need a person", async () => {
    open();
    const stats = closestElement(await screen.findByText("Jobs", { selector: ".label" }), ".stats");
    expect(within(stats).getByText("Jobs", { selector: ".label" }).nextSibling)
      .toHaveTextContent("5");
    expect(within(stats).getByText("Completed").nextSibling).toHaveTextContent("2");
    expect(within(stats).getByText("Need attention").nextSibling).toHaveTextContent("2");
    expect(within(stats).getByText("86%")).toBeInTheDocument();
  });

  it("counts the clusters across every job", async () => {
    open();
    expect(await screen.findByText("11 patched")).toBeInTheDocument();
    expect(screen.getByText("2 failed")).toBeInTheDocument();
    expect(screen.getByText("3 pending")).toBeInTheDocument();
  });

  it("says nothing rather than a percentage when no job has finished", async () => {
    answer(api, { patchReport: { ...PATCH_REPORT, avg_success_pct: null } });
    open();
    expect(await screen.findByText("—")).toBeInTheDocument();
  });

  it("shows the report failure without losing the job list", async () => {
    answer(api, { patchReport: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
    expect(screen.getByText("patch-2026-09-20-a")).toBeInTheDocument();
  });
});

describe("the job list", () => {
  it("draws a row per job with its change record, approval and progress", async () => {
    open();
    const row = closestElement(await screen.findByText("patch-2026-09-20-a"), "tr");
    expect(within(row).getByText("CHG0041233")).toBeInTheDocument();
    expect(within(row).getByText("m.okafor")).toBeInTheDocument();
    expect(within(row).getByText("4.16.9")).toBeInTheDocument();
    expect(within(row).getByText("paused")).toBeInTheDocument();
    expect(within(row).getByText(/\/ 5 · 60%/)).toBeInTheDocument();
  });

  it("says an unapproved job is pending rather than leaving the cell blank", async () => {
    open();
    const row = closestElement(await screen.findByText("patch-2026-09-18-b"), "tr");
    expect(within(row).getByText("pending")).toBeInTheDocument();
  });

  it("opens a job from its row", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByText("patch-2026-09-20-a"));
    expect(currentUrl()).toBe("/patching/patch-2026-09-20-a");
  });

  it("says where jobs come from when there are none", async () => {
    answer(api, { patchJobs: { count: 0, jobs: [] } });
    open();
    expect(await screen.findByText(/No patching jobs yet/)).toBeInTheDocument();
  });

  it("shows the job-list failure", async () => {
    answer(api, { patchJobs: fails("404 Not Found") });
    open();
    expect(await screen.findByText(/404 Not Found/)).toBeInTheDocument();
  });
});

describe("one job", () => {
  const openJob = () => open("/patching/patch-2026-09-20-a", "patch-2026-09-20-a");

  it("names it, with its status and how it did against the threshold", async () => {
    openJob();
    const head = parentOf(await screen.findByRole("heading", { name: "patch-2026-09-20-a" }));
    expect(within(head).getByText("paused")).toHaveClass("pill", "warning");
    expect(within(head).getByText("60% success (threshold 80%)")).toBeInTheDocument();
  });

  it("shows who asked, who approved and what it was aiming at", async () => {
    const { container } = openJob();
    await screen.findByText("Change record");
    // the change record is a list of plain spans: it has no role or name of
    // its own, so the DOM shape is what scopes these lookups
    const facts = container.querySelector(".kv") as HTMLElement;
    expect(within(facts).getByText("CHG0041233")).toBeInTheDocument();
    expect(within(facts).getByText("a.sthapit")).toBeInTheDocument();
    expect(within(facts).getByText("m.okafor (approved)")).toBeInTheDocument();
    expect(within(facts).getByText("4.16.9")).toBeInTheDocument();
  });

  it("lists the per-cluster outcome, with a dash where there is no number", async () => {
    openJob();
    const row = closestElement(await screen.findByText("ocp-dev-iad-01"), "tr");
    expect(within(row).getByText("skipped")).toBeInTheDocument();
    expect(within(row).getByText("? → —")).toBeInTheDocument();
    expect(within(row).getByText("— → —")).toBeInTheDocument();
  });

  it("shows a cluster that was patched, from and to", async () => {
    openJob();
    const row = closestElement(await screen.findByText("ocp-prod-iad-01"), "tr");
    expect(within(row).getByText("passed")).toBeInTheDocument();
    expect(within(row).getByText("4.16.7 → 4.16.9")).toBeInTheDocument();
    expect(within(row).getByText("97 → 96")).toBeInTheDocument();
  });

  it("shows the audit trail, in the order it happened", async () => {
    openJob();
    expect(await screen.findByText("Audit trail (3)")).toBeInTheDocument();
    expect(screen.getByText("submitted")).toBeInTheDocument();
    expect(screen.getByText("health check below threshold")).toBeInTheDocument();
    expect(screen.getByText("· ocp-prod-iad-02")).toBeInTheDocument();
  });

  it("goes back to the list", async () => {
    const user = userEvent.setup();
    const { back } = openJob();
    await user.click(await screen.findByText("← All jobs"));
    expect(back).toHaveBeenCalledWith("/patching");
  });

  it("shows the failure in place of the job", async () => {
    answer(api, { patchJob: fails("404 Not Found") });
    open("/patching/gone", "gone");
    expect(await screen.findByText(/404 Not Found/)).toBeInTheDocument();
  });

  it("stands the job in while it is on the wire", () => {
    answer(api, { patchJob: () => new Promise(() => {}) });
    const { container } = openJob();
    expect(container.querySelector(".skeleton-lines")).toBeInTheDocument();
  });
});
