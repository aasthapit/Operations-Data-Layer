import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import VariablesBar from "./VariablesBar";
import { normalizeDefinition } from "./model";

const definition = (variables) => normalizeDefinition({ id: "d", title: "D", variables });

const HUB_OPTIONS = [
  { value: "hub-east", label: "hub-east" },
  { value: "hub-west", label: "hub-west" },
];

const draw = (variables, { params = {}, variablesState = {}, right = null } = {}) => {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<VariablesBar definition={definition(variables)} params={params}
    variables={variablesState} onChange={onChange} right={right} />);
  return { onChange, user };
};

describe("a select variable", () => {
  const hub = [{ name: "hub", label: "Hub", type: "select", sql: "SELECT 1", required: true }];

  it("offers the options the run came back with, under the required prompt", () => {
    draw(hub, { variablesState: { hub: { options: HUB_OPTIONS } } });
    const select = screen.getByRole("combobox");
    expect([...select.options].map((o) => o.textContent))
      .toEqual(["choose hub…", "hub-east", "hub-west"]);
  });

  it("offers all rather than a prompt when the variable is not required", () => {
    draw([{ ...hub[0], required: false }], { variablesState: { hub: { options: HUB_OPTIONS } } });
    expect([...screen.getByRole("combobox").options][0]).toHaveTextContent("all");
  });

  it("marks a required variable that has no value", () => {
    const { container } = render(<VariablesBar definition={definition(hub)} params={{}}
      variables={{}} onChange={() => {}} />);
    expect(container.querySelector(".db-var")).toHaveClass("missing");
    expect(screen.getByTitle("Required")).toBeInTheDocument();
  });

  it("reports the value that was chosen", async () => {
    const { onChange, user } = draw(hub, { variablesState: { hub: { options: HUB_OPTIONS } } });
    await user.selectOptions(screen.getByRole("combobox"), "hub-west");
    expect(onChange).toHaveBeenCalledWith("hub", "hub-west");
  });

  it("keeps a value the snapshot no longer offers, and says it is not in it", () => {
    draw(hub, { params: { hub: "hub-retired" },
      variablesState: { hub: { options: HUB_OPTIONS } } });
    expect(screen.getByRole("option", { name: "hub-retired (not in this snapshot)" }))
      .toBeInTheDocument();
  });

  it("shows a value plainly before the options query has answered at all", () => {
    draw(hub, { params: { hub: "hub-east" } });
    expect(screen.getByRole("option", { name: "hub-east" })).toBeInTheDocument();
  });

  it("says why the selector is empty rather than implying the fleet has no hubs", () => {
    draw(hub, { variablesState: { hub: { options: [], error: "unknown table 'hubz'" } } });
    expect(screen.getByText("unknown table 'hubz'")).toBeInTheDocument();
  });

  it("offers a multi-select as a list and reports every value that was picked", async () => {
    const envs = [{ name: "envs", label: "Environments", type: "select", multi: true,
      sql: "SELECT 1" }];
    const { onChange, user } = draw(envs, {
      params: { envs: ["prod"] },
      variablesState: { envs: { options: [
        { value: "prod", label: "prod" }, { value: "stage", label: "stage" },
        { value: "dev", label: "dev" }] } },
    });
    const select = screen.getByRole("listbox");
    expect(select).toHaveAttribute("multiple");
    await user.selectOptions(select, ["prod", "stage"]);
    expect(onChange).toHaveBeenCalledWith("envs", ["prod", "stage"]);
  });
});

describe("a text or number variable", () => {
  const days = [{ name: "days", label: "Days", type: "number", default: 7 }];

  it("commits when the field is left rather than on every keystroke", async () => {
    const { onChange, user } = draw(days, { params: { days: 7 } });
    const box = screen.getByRole("spinbutton");
    await user.clear(box);
    await user.type(box, "14");
    expect(onChange).not.toHaveBeenCalled();
    await user.tab();
    expect(onChange).toHaveBeenCalledExactlyOnceWith("days", "14");
  });

  it("commits on Enter, which blurs the field", async () => {
    const { onChange, user } = draw(days, { params: { days: 7 } });
    const box = screen.getByRole("spinbutton");
    await user.clear(box);
    await user.type(box, "30{Enter}");
    expect(onChange).toHaveBeenCalledWith("days", "30");
  });

  it("does not report a value that did not change", async () => {
    const { onChange, user } = draw(days, { params: { days: 7 } });
    await user.click(screen.getByRole("spinbutton"));
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("takes a new value from outside, which is how the back button moves it", () => {
    const { rerender } = render(<VariablesBar definition={definition(days)} params={{ days: 7 }}
      variables={{}} onChange={() => {}} />);
    expect(screen.getByRole("spinbutton")).toHaveValue(7);
    rerender(<VariablesBar definition={definition(days)} params={{ days: 30 }}
      variables={{}} onChange={() => {}} />);
    expect(screen.getByRole("spinbutton")).toHaveValue(30);
  });

  it("says whether a value is required or optional in the placeholder", () => {
    draw([{ name: "team", type: "text", required: true }]);
    expect(screen.getByPlaceholderText("required")).toBeInTheDocument();
  });
});

describe("the bar itself", () => {
  it("is not drawn at all for a dashboard with no variables and nothing to say", () => {
    const { container } = render(<VariablesBar definition={definition([])} params={{}}
      variables={{}} onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is drawn for its right-hand slot even with no variables", () => {
    draw([], { right: <span>refreshing…</span> });
    expect(screen.getByText("refreshing…")).toBeInTheDocument();
    expect(screen.getByText("This dashboard has no variables.")).toBeInTheDocument();
  });
});
