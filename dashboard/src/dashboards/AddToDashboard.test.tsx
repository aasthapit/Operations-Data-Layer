import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import AddToDashboard from "./AddToDashboard";
import * as cache from "../cache";
import { CAPACITY_WATCH, DASHBOARD_LIST, HUB_REVIEW } from "../test/fixtures/dashboards";
import type { DashboardDefinition } from "../api/types";

vi.mock("../api", () => ({
  api: {
    dashboards: vi.fn(),
    dashboard: vi.fn(),
    saveDashboard: vi.fn(),
  },
}));
// The module is replaced wholesale above, so what these tests drive is a bag
// of vi.fn()s rather than the real client - which is why a stub only has to
// carry the fields the dialog actually reads off a descriptor.
const { api } = await import("../api") as unknown as { api: Record<string, Mock> };

const SQL = "SELECT name, overall_status FROM clusters WHERE hub_name = 'hub-east'";

beforeEach(() => {
  // The api spies live for the whole file, so their call lists are cleared
  // between tests; otherwise calls[0] is the previous test's write.
  vi.clearAllMocks();
  cache.invalidate();
  api.dashboards.mockReturnValue({ url: "/api/dashboards", load: async () => DASHBOARD_LIST });
  // api.dashboard hands back a thenable descriptor; the dialog simply awaits it.
  const stored: Record<string, DashboardDefinition> =
    { "hub-review": HUB_REVIEW, "capacity-watch": CAPACITY_WATCH };
  api.dashboard.mockImplementation((id: string) => ({
    url: `/api/dashboards/${id}`,
    then: (ok: (d: DashboardDefinition) => unknown, fail: (e: unknown) => unknown) =>
      Promise.resolve(stored[id]).then(ok, fail),
  }));
  api.saveDashboard.mockResolvedValue({ ok: true });
});

function open(props = {}) {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<AddToDashboard sql={SQL} chart={{ type: "bars" }} defaultTitle="clusters"
    onAdded={onAdded} onClose={onClose} {...props} />);
  return { onAdded, onClose, user };
}

describe("choosing where the panel goes", () => {
  it("groups the dashboards that can be written to apart from the ones that must be cloned",
    async () => {
      open();
      const select = await screen.findByRole("combobox");
      const groups = [...select.querySelectorAll("optgroup")].map((g) => g.label);
      expect(groups).toEqual(["Saved", "Built in - clones"]);
      expect(screen.getByRole("option", { name: "Capacity watch" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "Clone Hub review - {{hub}}" }))
        .toBeInTheDocument();
    });

  it("says nothing can be added until a dashboard is chosen", async () => {
    open();
    await screen.findByRole("combobox");
    expect(screen.getByRole("button", { name: "Add panel" })).toBeDisabled();
  });

  it("asks for a new id, and changes the button, once a built-in is chosen", async () => {
    const { user } = open();
    await user.selectOptions(await screen.findByRole("combobox"), "hub-review");
    expect(screen.getByDisplayValue("hub-review-copy")).toBeInTheDocument();
    expect(screen.getByText(/\/dashboards\/hub-review-copy/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clone and add" })).toBeEnabled();
  });

  it("warns that a query with a variable in it needs the dashboard to declare one", async () => {
    const { container } = { container: document.body,
      ...open({ sql: "SELECT name FROM clusters WHERE hub_name = {{hub}} AND region = {{region}}" }) };
    await screen.findByRole("combobox");
    // the warning line has no role or name of its own; its class is how the
    // dialog marks it, so the DOM shape is the point here
    const desc = container.querySelector(".q-desc") as HTMLElement;
    expect(desc.textContent).toContain("This query uses {{hub}}, {{region}}.");
    expect(desc.textContent).toContain("declare those variables");
  });

  it("shows the SQL the panel will store", async () => {
    open();
    await screen.findByRole("combobox");
    expect(screen.getByText(SQL)).toBeInTheDocument();
  });
});

describe("adding the panel", () => {
  it("appends the panel to the chosen dashboard and writes the whole definition back",
    async () => {
      const { onAdded, user } = open();
      await user.selectOptions(await screen.findByRole("combobox"), "capacity-watch");
      await user.click(screen.getByRole("button", { name: "Add panel" }));
      await vi.waitFor(() => expect(onAdded).toHaveBeenCalledWith("capacity-watch"));
      const [id, body] = api.saveDashboard.mock.calls[0];
      expect(id).toBe("capacity-watch");
      expect(body.panels).toHaveLength(CAPACITY_WATCH.panels.length + 1);
      expect(body.panels.at(-1)).toMatchObject({ title: "clusters", sql: SQL,
        chart: { type: "bars" } });
    });

  it("takes the size the user set", async () => {
    const { user } = open();
    await user.selectOptions(await screen.findByRole("combobox"), "capacity-watch");
    await user.click(screen.getByRole("button", { name: "Increase Width" }));
    await user.click(screen.getByRole("button", { name: "Increase Height" }));
    await user.click(screen.getByRole("button", { name: "Add panel" }));
    await vi.waitFor(() => expect(api.saveDashboard).toHaveBeenCalled());
    const [, body] = api.saveDashboard.mock.calls[0];
    expect(body.panels.at(-1)).toMatchObject({ w: 7, h: 3, sql: SQL, title: "clusters" });
  });

  it("clones a built-in under the new id and lands the panel on the copy", async () => {
    const { onAdded, user } = open();
    await user.selectOptions(await screen.findByRole("combobox"), "hub-review");
    await user.click(screen.getByRole("button", { name: "Clone and add" }));
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalledWith("hub-review-copy"));
    const [id, body] = api.saveDashboard.mock.calls[0];
    expect(id).toBe("hub-review-copy");
    expect(body.id).toBe("hub-review-copy");
    expect(body.title).toBe("Hub review - {{hub}} (copy)");
    expect(body.panels).toHaveLength(HUB_REVIEW.panels.length + 1);
  });

  it("refuses to add a panel with no title", async () => {
    const { user } = open({ defaultTitle: "" });
    await user.selectOptions(await screen.findByRole("combobox"), "capacity-watch");
    expect(screen.getByRole("button", { name: "Add panel" })).toBeDisabled();
  });

  it("shows the API's refusal and leaves the dialog open to try again", async () => {
    api.saveDashboard.mockRejectedValue(new Error("a panel needs a query"));
    const { onAdded, user } = open();
    await user.selectOptions(await screen.findByRole("combobox"), "capacity-watch");
    await user.click(screen.getByRole("button", { name: "Add panel" }));
    expect(await screen.findByText("a panel needs a query")).toBeInTheDocument();
    expect(onAdded).not.toHaveBeenCalled();
  });
});

describe("when there is nowhere to add it", () => {
  it("says the data layer does not serve dashboards yet on a 404", async () => {
    api.dashboards.mockReturnValue({ url: "/api/dashboards",
      load: async () => { throw Object.assign(new Error("404"), { status: 404 }); } });
    open();
    expect(await screen.findByText(/does not serve dashboards yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add panel" })).toBeNull();
  });

  it("shows any other failure as it came", async () => {
    api.dashboards.mockReturnValue({ url: "/api/dashboards",
      load: async () => { throw new Error("503 Service Unavailable"); } });
    open();
    expect(await screen.findByText("503 Service Unavailable")).toBeInTheDocument();
  });
});
