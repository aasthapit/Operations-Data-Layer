import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Applications from "./Applications";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { closestElement, currentUrl, parentOf, renderView } from "../test/harness";
import { APPLICATIONS, APPLICATION_DETAIL } from "../test/fixtures/insights";

/** A data row of a table. The grid draws divs, so a row is what carries the
 * role rather than a `<tr>`. */
const GRID_ROW = '[role="row"]';

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
  answer(api, { applications: APPLICATIONS, application: APPLICATION_DETAIL });
});

const open = (at = "/applications", app?: string) => renderView(
  ({ route, nav }) => <Applications app={app} route={route} nav={nav} />, { at });

describe("the list", () => {
  it("draws a row per application with its ownership and its health", async () => {
    open();
    const row = closestElement(await screen.findByText("checkout"), GRID_ROW);
    expect(within(row).getByText("payments")).toBeInTheDocument();
    expect(within(row).getByText("critical")).toBeInTheDocument();
    expect(within(row).getByText("warning")).toBeInTheDocument();
    expect(within(row).getByText("19/22")).toBeInTheDocument();
    expect(within(row).getByText("6.02 cores")).toBeInTheDocument();
    expect(within(row).getByText("12.0 GiB")).toBeInTheDocument();
  });

  it("names the first few clusters an application runs on, and how many more", async () => {
    open();
    const row = closestElement(await screen.findByText("checkout"), GRID_ROW);
    expect(within(row).getByText(/ocp-prod-iad-02, ocp-stage-iad-01/)).toBeInTheDocument();
  });

  it("marks namespaces that are under no business application", async () => {
    open();
    expect(await screen.findByText("not under a business application")).toBeInTheDocument();
  });

  it("says usage is not available rather than showing a zero", async () => {
    open();
    const row = closestElement(await screen.findByText("(unassigned)"), GRID_ROW);
    expect(within(row).getAllByText("n/a")).toHaveLength(2);
  });

  it("counts the applications in the footer", async () => {
    open();
    expect(await screen.findByText("3 applications")).toBeInTheDocument();
  });

  it("explains label ownership when that is where it comes from", async () => {
    open();
    expect(await screen.findByText(/Every non-platform namespace is an application/))
      .toBeInTheDocument();
    expect(screen.getByLabelText("Team")).toBeInTheDocument();
    expect(screen.getByLabelText("Tier")).toBeInTheDocument();
  });

  it("explains mapping-file ownership, and offers the assigned filter instead of tier",
    async () => {
      answer(api, { applications: { ...APPLICATIONS, source: "mapping" } });
      open();
      expect(await screen.findByText(/Ownership comes from the application mapping file/))
        .toBeInTheDocument();
      expect(screen.getByLabelText("LOB")).toBeInTheDocument();
      expect(screen.getByLabelText("Assigned")).toBeInTheDocument();
      expect(screen.queryByLabelText("Tier")).toBeNull();
      expect(screen.getByText("Namespace envs")).toBeInTheDocument();
    });

  it("narrows the query and writes the filter into the URL", async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(await screen.findByLabelText("Team"), "payments");
    expect(currentUrl()).toBe("/applications?team=payments");
    await waitFor(() => expect(api.applications)
      .toHaveBeenCalledWith(expect.objectContaining({ team: "payments" })));
  });

  it("clears every filter at once", async () => {
    const user = userEvent.setup();
    open("/applications?team=payments&status=warning");
    await user.click(await screen.findByRole("button", { name: "Clear" }));
    expect(currentUrl()).toBe("/applications");
  });

  it("opens an application from its row", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByText("catalog"));
    expect(currentUrl()).toBe("/applications/catalog");
  });

  it("shows the failure in place of the table", async () => {
    answer(api, { applications: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText(/503 Service Unavailable/)).toBeInTheDocument();
  });
});

describe("one application", () => {
  it("names it, with its status, tier and owner", async () => {
    const { container } = open("/applications/checkout", "checkout");
    const head = parentOf(await screen.findByRole("heading", { name: "checkout" }));
    expect(within(head).getByText("warning")).toHaveClass("pill");
    expect(within(head).getByText("critical").closest("[data-tier]"))
      .toHaveAttribute("data-tier", "critical");
    expect(within(head).getByText("LOB payments")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /All applications/ })).toBeInTheDocument();
  });

  it("lists every placement with the cluster it is on", async () => {
    open("/applications/checkout", "checkout");
    const row = closestElement(await screen.findByText("checkout-prod"), GRID_ROW);
    expect(within(row).getByText("ocp-prod-iad-02")).toBeInTheDocument();
    expect(within(row).getByText("4.16.7")).toBeInTheDocument();
    expect(within(row).getByText("12/14")).toBeInTheDocument();
    expect(screen.getByText("Placements (2 clusters)")).toBeInTheDocument();
  });

  it("opens the cluster a placement is on", async () => {
    const user = userEvent.setup();
    open("/applications/checkout", "checkout");
    await user.click(await screen.findByText("checkout-stage"));
    expect(currentUrl()).toBe("/clusters/ocp-stage-iad-01");
  });

  it("lists the workloads with their env sources, and never a value", async () => {
    open("/applications/checkout", "checkout");
    expect(await screen.findByText("Workloads (1)")).toBeInTheDocument();
    expect(screen.getByText("(literal, scrubbed)")).toBeInTheDocument();
    expect(screen.getByText("← Secret checkout-db/password")).toBeInTheDocument();
    expect(screen.getByText("Secret checkout-db (env)")).toBeInTheDocument();
  });

  it("goes back to the list", async () => {
    const user = userEvent.setup();
    const { back } = open("/applications/checkout", "checkout");
    await user.click(await screen.findByRole("button", { name: /All applications/ }));
    expect(back).toHaveBeenCalledWith("/applications");
  });

  it("shows the failure in place of the detail", async () => {
    answer(api, { application: fails("404 Not Found") });
    open("/applications/gone", "gone");
    expect(await screen.findByText(/404 Not Found/)).toBeInTheDocument();
  });

  it("paints the header from the row the user clicked while the detail is still out",
    async () => {
      answer(api, { application: () => new Promise(() => {}) });
      // What the list left in the cache, under the url the list asked for.
      const listUrl = api.applications({ team: "", tier: "", assigned: "", environment: "",
        status: "" }).url;
      cache.put(listUrl, APPLICATIONS);
      open("/applications/checkout", "checkout");
      const head = parentOf(await screen.findByRole("heading", { name: "checkout" }));
      expect(within(head).getByText("warning")).toHaveClass("pill");
    });
});
