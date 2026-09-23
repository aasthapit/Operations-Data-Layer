import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Drawer, Field, IdDialog, Menu, Modal, Stepper } from "./ui";
import type { MenuItem } from "./ui";

describe("Menu", () => {
  // A tuple rather than an array, so a test can reach for the first entry
  // without first proving it is not the conditioned-away one.
  const items = (): [MenuItem, MenuItem, false] => [
    { label: "Open in Query", onSelect: vi.fn() },
    { label: "Remove", onSelect: vi.fn(), danger: true },
    false,
  ];

  it("draws nothing at all when every item was conditioned away", () => {
    const { container } = render(<Menu items={[false, null, undefined]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("opens on a click and reports which item was chosen", async () => {
    const user = userEvent.setup();
    const list = items();
    render(<Menu items={list} title="Menu for Clusters on hub-east" />);
    // The button's label is its own glyph; the panel it belongs to is in the
    // title, which is what tells two panels' menus apart.
    const button = screen.getByRole("button", { name: "⋯" });
    expect(button).toHaveAttribute("title", "Menu for Clusters on hub-east");
    expect(button).toHaveAttribute("aria-expanded", "false");
    await user.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("menuitem", { name: "Open in Query" }));
    expect(list[0].onSelect).toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("marks a destructive item so it does not read like the others", async () => {
    const user = userEvent.setup();
    render(<Menu items={items()} />);
    await user.click(screen.getByRole("button", { name: "⋯" }));
    expect(screen.getByRole("menuitem", { name: "Remove" })).toHaveClass("danger");
  });

  it("closes on Escape and on a click outside it", async () => {
    const user = userEvent.setup();
    render(<div><Menu items={items()} /><button type="button">elsewhere</button></div>);
    const button = screen.getByRole("button", { name: "⋯" });

    await user.click(button);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(button);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("Modal", () => {
  it("is a labelled dialog with the footer the caller gave it", () => {
    render(<Modal title="Delete this dashboard" onClose={() => {}}
      footer={<button type="button">Delete</button>}>Are you sure?</Modal>);
    const dialog = screen.getByRole("dialog", { name: "Delete this dashboard" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("closes on its own button, on Escape and on a click outside", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Modal title="Add to dashboard" onClose={onClose}>body</Modal>);

    await user.click(screen.getByRole("button", { name: "×" }));
    await user.keyboard("{Escape}");
    // the scrim is the modal's own backdrop: it carries no role or name,
    // because clicking it is the shape of the dialog rather than a control
    await user.click(document.querySelector(".db-scrim") as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("puts the focus back where it was when it goes away", async () => {
    render(<button type="button">Clone to edit</button>);
    const opener = screen.getByRole("button", { name: "Clone to edit" });
    opener.focus();
    const { unmount } = render(<Modal title="Clone" onClose={() => {}}>body</Modal>);
    unmount();
    expect(document.activeElement).toBe(opener);
  });
});

describe("Drawer", () => {
  it("is a labelled dialog that closes the way the modal does", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Drawer title="Edit &quot;Clusters&quot;" onClose={onClose}
      footer={<button type="button">Apply</button>}>the form</Drawer>);
    expect(screen.getByRole("dialog", { name: 'Edit "Clusters"' })).toBeInTheDocument();
    expect(screen.getByText("the form")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});

describe("IdDialog", () => {
  const setup = (props = {}) => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<IdDialog title="Clone this dashboard" intro="A copy under a new id."
      defaultId="hub-review-copy" onSubmit={onSubmit} onCancel={onCancel} {...props} />);
    return { onSubmit, onCancel, user };
  };

  it("shows the URL the id will live at as the user types", async () => {
    const { user } = setup();
    expect(screen.getByText(/\/dashboards\/hub-review-copy/)).toBeInTheDocument();
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Hub Capacity Review");
    expect(screen.getByText(/\/dashboards\/hub-capacity-review/)).toBeInTheDocument();
  });

  it("submits the slug rather than what was typed", async () => {
    const { onSubmit, user } = setup();
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "Hub Capacity Review");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(onSubmit).toHaveBeenCalledWith("hub-capacity-review");
  });

  it("submits on Enter, and does not when there is no usable id", async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByRole("textbox"), "{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("hub-review-copy");

    onSubmit.mockClear();
    await user.clear(screen.getByRole("textbox"));
    await user.type(screen.getByRole("textbox"), "!!!{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });

  it("says it is saving and refuses a second submit while it is", () => {
    setup({ busy: true });
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  });

  it("shows the API's refusal in place of the hint", () => {
    setup({ error: "a dashboard with that id already exists" });
    expect(screen.getByText("a dashboard with that id already exists")).toBeInTheDocument();
    expect(screen.queryByText(/The URL will be/)).toBeNull();
  });

  it("cancels", async () => {
    const { onCancel, user } = setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("Field", () => {
  it("shows the hint until there is an error to show instead", () => {
    const { rerender } = render(
      <Field label="SQL" hint="A single SELECT."><textarea /></Field>);
    expect(screen.getByText("A single SELECT.")).toBeInTheDocument();
    rerender(<Field label="SQL" hint="A single SELECT." error="unknown table 'pods'">
      <textarea />
    </Field>);
    expect(screen.getByText("unknown table 'pods'")).toBeInTheDocument();
    expect(screen.queryByText("A single SELECT.")).toBeNull();
  });
});

describe("Stepper", () => {
  it("nudges the value and stops at each end", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <Stepper label="Width" value={6} min={1} max={12} onChange={onChange} suffix="/ 12" />);
    await user.click(screen.getByRole("button", { name: "Increase Width" }));
    expect(onChange).toHaveBeenCalledWith(7);
    await user.click(screen.getByRole("button", { name: "Decrease Width" }));
    expect(onChange).toHaveBeenCalledWith(5);
    expect(screen.getByText("6 / 12")).toBeInTheDocument();

    rerender(<Stepper label="Width" value={1} min={1} max={12} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Decrease Width" })).toBeDisabled();
    rerender(<Stepper label="Width" value={12} min={1} max={12} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Increase Width" })).toBeDisabled();
  });
});
