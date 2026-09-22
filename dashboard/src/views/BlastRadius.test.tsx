import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BlastRadius from "./BlastRadius";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { currentUrl, renderView } from "../test/harness";
import { BLAST_RADIUS, OPERATOR_VERSIONS, VERSIONS } from "../test/fixtures/fleet";
import { OLM_OPERATORS } from "../test/fixtures/insights";

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
  answer(api, {
    versions: VERSIONS,
    operatorVersions: OPERATOR_VERSIONS,
    olmOperators: OLM_OPERATORS,
    blastRadius: BLAST_RADIUS,
  });
});

const open = (at = "/blast") => renderView(
  ({ route, nav }) => <BlastRadius route={route} nav={nav} />, { at });

describe("the form", () => {
  it("says what the page is for before anything has been run", async () => {
    open();
    expect(await screen.findByText("Run a query to see the impact.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Compute blast radius" })).toBeDisabled();
  });

  it("offers the versions, operators and packages the fleet actually has", async () => {
    open();
    const ocp = await screen.findByLabelText<HTMLSelectElement>("OCP version");
    expect([...ocp.options].map((o) => o.value)).toEqual(["", "4.16.7", "4.16.4", "4.15.22"]);
    expect([...screen.getByLabelText<HTMLSelectElement>("Cluster operator").options].map((o) => o.value))
      .toEqual(["", "ingress", "network", "authentication"]);
    expect([...screen.getByLabelText<HTMLSelectElement>("OLM operator").options].map((o) => o.value))
      .toEqual(["", "elasticsearch-operator"]);
  });

  it("keeps the version pickers shut until their operator is chosen", async () => {
    const user = userEvent.setup();
    open();
    expect(await screen.findByLabelText("Operator version")).toBeDisabled();
    await user.selectOptions(screen.getByLabelText("Cluster operator"), "ingress");
    const versions = screen.getByLabelText<HTMLSelectElement>("Operator version");
    expect(versions).toBeEnabled();
    expect([...versions.options].map((o) => o.value)).toEqual(["", "4.16.7", "4.15.22"]);
  });

  it("clears the operator version when the operator itself changes", async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(await screen.findByLabelText("Cluster operator"), "ingress");
    await user.selectOptions(screen.getByLabelText("Operator version"), "4.15.22");
    await user.selectOptions(screen.getByLabelText("Cluster operator"), "network");
    expect(screen.getByLabelText("Operator version")).toHaveValue("");
  });

  it("offers the OLM versions of the package that was chosen", async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(await screen.findByLabelText("OLM operator"),
      "elasticsearch-operator");
    expect([...screen.getByLabelText<HTMLSelectElement>("OLM version").options].map((o) => o.value))
      .toEqual(["", "5.8.6", "5.8.4"]);
  });

  it("runs on an image substring alone", async () => {
    const user = userEvent.setup();
    open();
    await user.type(await screen.findByPlaceholderText("quay.io/acme", { exact: false }), "checkout:1.9.2");
    await user.click(screen.getByRole("button", { name: "Compute blast radius" }));
    expect(currentUrl()).toContain("image=checkout%3A1.9.2");
    await waitFor(() => expect(api.blastRadius)
      .toHaveBeenCalledWith(expect.objectContaining({ image: "checkout:1.9.2" })));
  });

  it("carries the degraded-only flag into the query", async () => {
    const user = userEvent.setup();
    open();
    await user.selectOptions(await screen.findByLabelText("OCP version"), "4.16.7");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Compute blast radius" }));
    await waitFor(() => expect(api.blastRadius)
      .toHaveBeenCalledWith(expect.objectContaining({ degraded_only: true })));
  });
});

describe("running from a link", () => {
  it("restores the form from the URL and runs it without being asked", async () => {
    open("/blast?ocp_version=4.16.7");
    expect(await screen.findByText("Clusters impacted")).toBeInTheDocument();
    expect(screen.getByLabelText("OCP version")).toHaveValue("4.16.7");
    expect(api.blastRadius).toHaveBeenCalledWith(expect.objectContaining({
      ocp_version: "4.16.7", degraded_only: false }));
  });

  it("reads degraded_only back out of the URL", async () => {
    open("/blast?operator=ingress&degraded_only=true");
    await screen.findByText("Clusters impacted");
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("shows the failure rather than a half-drawn report", async () => {
    answer(api, { blastRadius: fails("504 Gateway Timeout") });
    open("/blast?ocp_version=4.16.7");
    expect(await screen.findByText(/504 Gateway Timeout/)).toBeInTheDocument();
    expect(screen.getByText("Run a query to see the impact.")).toBeInTheDocument();
  });
});

describe("the report", () => {
  const openReport = () => open("/blast?ocp_version=4.16.7");

  it("counts what the change would touch", async () => {
    openReport();
    const stats = (await screen.findByText("Clusters impacted")).closest<HTMLElement>(".stats");
    expect(within(stats).getByText("Clusters impacted").nextSibling).toHaveTextContent("2");
    expect(within(stats).getByText("Applications").nextSibling).toHaveTextContent("3");
    expect(within(stats).getByText("Critical apps").nextSibling).toHaveTextContent("1");
    expect(within(stats).getByText("Teams").nextSibling).toHaveTextContent("2");
    expect(within(stats).getByText("Workloads").nextSibling).toHaveTextContent("2");
  });

  it("lists the clusters with why each one matched", async () => {
    const { container } = openReport();
    await screen.findByText("Impacted clusters");
    const clusters = container.querySelector<HTMLElement>("#blast-clusters, .card.flush");
    const row = within(clusters).getByText("ocp-stage-iad-01").closest<HTMLElement>("tr");
    expect(within(row).getByText("ocp_version 4.16.7")).toBeInTheDocument();
    expect(within(row).getByText("critical")).toBeInTheDocument();
  });

  it("lists the applications riding on those clusters", async () => {
    openReport();
    const row = (await screen.findByText("checkout")).closest<HTMLElement>("tr");
    expect(within(row).getByText("payments")).toBeInTheDocument();
    expect(within(row).getByText("2")).toHaveAttribute("title",
      "ocp-prod-iad-02, ocp-stage-iad-01");
  });

  it("lists the exact workloads when the query was about an image", async () => {
    openReport();
    expect(await screen.findByText("Impacted workloads")).toBeInTheDocument();
    expect(screen.getAllByText("Deployment/checkout-api")).toHaveLength(2);
    expect(screen.getAllByText("quay.io/acme/checkout:1.9.2")).toHaveLength(2);
  });

  it("leaves the workloads table out when nothing named one", async () => {
    answer(api, { blastRadius: { ...BLAST_RADIUS, workloads: [],
      summary: { ...BLAST_RADIUS.summary, workloads_impacted: 0 } } });
    openReport();
    await screen.findByText("Clusters impacted");
    expect(screen.queryByText("Impacted workloads")).toBeNull();
    expect(screen.queryByText("Workloads")).toBeNull();
  });

  it("shows the spread by environment, by hub and over the platform", async () => {
    openReport();
    const spread = (await screen.findByText("By environment")).closest<HTMLElement>(".card");
    expect(within(spread).getByText("prod").closest<HTMLElement>("div")).toHaveTextContent("prod 1");
    expect(within(spread).getByText("stage").closest<HTMLElement>("div")).toHaveTextContent("stage 1");
    expect(within(spread).getByText("By hub")).toBeInTheDocument();
    expect(within(spread).getByText("hub-east").closest<HTMLElement>("div")).toHaveTextContent("hub-east 2");
    expect(within(spread).getByText("openshift-ingress")).toBeInTheDocument();
  });

  it("falls back to the spread by region on an API that reports it that way", async () => {
    const { by_hub, ...rest } = BLAST_RADIUS.summary;
    answer(api, { blastRadius: { ...BLAST_RADIUS,
      summary: { ...rest, by_region: { "us-east-1": 2 } } } });
    openReport();
    expect(await screen.findByText("us-east-1")).toBeInTheDocument();
  });

  it("opens a cluster from the impacted list", async () => {
    const user = userEvent.setup();
    const { container } = openReport();
    await screen.findByText("Impacted clusters");
    const clusters = container.querySelector<HTMLElement>(".card.flush");
    await user.click(within(clusters).getByText("ocp-prod-iad-02"));
    expect(currentUrl()).toBe("/clusters/ocp-prod-iad-02");
  });

  it("opens an application from the impacted list", async () => {
    const user = userEvent.setup();
    openReport();
    await user.click(await screen.findByText("catalog"));
    expect(currentUrl()).toBe("/applications/catalog");
  });
});
