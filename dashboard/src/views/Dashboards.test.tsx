import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Dashboards from "./Dashboards";
import * as cache from "../cache";
import { answer, fails, notFound } from "../test/apiMock";
import type { ApiMock } from "../test/apiMock";
import { currentUrl, renderView } from "../test/harness";
import { DASHBOARD_LIST, HUB_REVIEW } from "../test/fixtures/dashboards";

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
    dashboards: DASHBOARD_LIST,
    dashboard: HUB_REVIEW,
    saveDashboard: { ok: true },
  });
});

const open = (at = "/dashboards") => renderView(
  ({ route, nav }) => <Dashboards route={route} />, { at });

describe("the list", () => {
  it("separates what ships with the data layer from what was made here", async () => {
    open();
    expect(await screen.findByText("Built in")).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("built in")).toBeInTheDocument();
  });

  it("shows a variable slot in a title as the variable rather than as a gap", async () => {
    open();
    const card = (await screen.findByText(/Hub review/)).closest<HTMLElement>(".db-card");
    expect(within(card).getByText("hub", { selector: ".db-slot" })).toBeInTheDocument();
  });

  it("counts the panels and names the variables a dashboard takes", async () => {
    open();
    const card = (await screen.findByText(/Hub review/)).closest<HTMLElement>(".db-card");
    expect(within(card).getByText("2 panels")).toBeInTheDocument();
    expect(within(card).getByText("hub", { selector: ".db-card-vars .tag" }))
      .toBeInTheDocument();
  });

  it("says panel rather than panels for one, and says when there is no description",
    async () => {
      open();
      const card = (await screen.findByText("Capacity watch")).closest<HTMLElement>(".db-card");
      expect(within(card).getByText("1 panel")).toBeInTheDocument();
      expect(within(card).getByText("No description.")).toBeInTheDocument();
      expect(within(card).getByText(/^updated /)).toBeInTheDocument();
    });

  it("opens a dashboard", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByText("Capacity watch"));
    expect(currentUrl()).toBe("/dashboards/capacity-watch");
  });

  it("says so when there are none yet", async () => {
    answer(api, { dashboards: { dashboards: [] } });
    open();
    expect(await screen.findByText(/No dashboards yet/)).toBeInTheDocument();
  });

  it("re-reads the list on demand", async () => {
    const user = userEvent.setup();
    const reads = vi.fn(() => DASHBOARD_LIST);
    answer(api, { dashboards: reads });
    open();
    await screen.findByText("Capacity watch");
    await user.click(screen.getByRole("button", { name: "↻ Refresh" }));
    await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThan(1));
  });

  it("sends the user to the agent to describe one instead", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Generate from a question" }));
    expect(currentUrl()).toBe("/generate");
  });
});

describe("naming a new one", () => {
  it("shows the URL it will live at, and opens it as a draft", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "New dashboard" }));
    await user.type(screen.getByRole("textbox"), "Hub capacity review");
    expect(screen.getByText(/\/dashboards\/hub-capacity-review/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(currentUrl()).toBe("/dashboards/hub-capacity-review?new=1");
  });

  it("refuses a name that does not make an id", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "New dashboard" }));
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "!!!");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("can be cancelled", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "New dashboard" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("cloning a built-in", () => {
  it("reads the original, writes the copy and opens it", async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Clone" }));
    expect(screen.getByRole("dialog", { name: 'Clone "Hub review - {{hub}}"' }))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(currentUrl()).toBe("/dashboards/hub-review-copy"));
    const [id, body] = api.saveDashboard.mock.calls[0];
    expect(id).toBe("hub-review-copy");
    expect(body.title).toBe("Hub review - {{hub}} (copy)");
    expect(body.panels).toHaveLength(2);
    expect(body).not.toHaveProperty("builtin");
  });

  it("shows the API's refusal and leaves the dialog alone", async () => {
    answer(api, { saveDashboard: fails("a dashboard with that id already exists") });
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole("button", { name: "Clone" }));
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect(await screen.findByText("a dashboard with that id already exists"))
      .toBeInTheDocument();
  });

  it("is not offered for a dashboard that can simply be edited", async () => {
    open();
    const card = (await screen.findByText("Capacity watch")).closest<HTMLElement>(".db-card");
    expect(within(card).queryByRole("button", { name: "Clone" })).toBeNull();
  });
});

describe("when the data layer has no dashboard plane", () => {
  it("says which endpoint answered 404, and offers the sample dashboards", async () => {
    const user = userEvent.setup();
    answer(api, { dashboards: notFound() });
    open();
    expect(await screen.findByText("This data layer does not serve dashboards yet"))
      .toBeInTheDocument();
    expect(screen.getByText(/GET \/api\/dashboards answered 404/)).toBeInTheDocument();
    await user.click(screen.getByText("Load the sample dashboards"));
    expect(currentUrl()).toBe("/dashboards?fixture=1");
  });

  it("shows any other failure as it came", async () => {
    answer(api, { dashboards: fails("503 Service Unavailable") });
    open();
    expect(await screen.findByText("Dashboards could not be loaded")).toBeInTheDocument();
    expect(screen.getByText("503 Service Unavailable")).toBeInTheDocument();
  });
});

describe("the fixture list", () => {
  it("lists the sample dashboards without calling the API", async () => {
    open("/dashboards?fixture=1");
    expect(await screen.findByText(/Hub overview/)).toBeInTheDocument();
    expect(screen.getByText("Fleet trends")).toBeInTheDocument();
    expect(screen.getByText("fixture")).toHaveClass("db-tag");
    expect(api.dashboards).not.toHaveBeenCalled();
  });

  it("keeps the fixture flag on every way out of the page", async () => {
    const user = userEvent.setup();
    open("/dashboards?fixture=1");
    await user.click(await screen.findByText("Fleet trends"));
    expect(currentUrl()).toBe("/dashboards/fixture-fleet?fixture=1");
  });

  it("does not offer the sample dashboards to a page that is already showing them",
    async () => {
      answer(api, { dashboards: notFound() });
      open("/dashboards?fixture=1&broken=1");
      await screen.findByText(/Hub overview/);
      expect(screen.queryByText("Load the sample dashboards")).toBeNull();
    });
});
