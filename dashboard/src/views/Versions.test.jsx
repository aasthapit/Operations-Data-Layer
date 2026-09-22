import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Versions from "./Versions";
import * as cache from "../cache";
import { answer, fails } from "../test/apiMock";
import { OPERATOR_VERSIONS, VERSIONS } from "../test/fixtures/fleet";

vi.mock("../api", async () => {
  const { createApiMock } = await import("../test/apiMock");
  return { api: createApiMock(), BASE: "" };
});
const { api } = await import("../api");

beforeEach(() => {
  vi.clearAllMocks();
  cache.invalidate();
  answer(api, { versions: VERSIONS, operatorVersions: OPERATOR_VERSIONS });
});

function open() {
  const onOpen = vi.fn();
  const onBlast = vi.fn();
  const user = userEvent.setup();
  render(<Versions onOpen={onOpen} onBlast={onBlast} />);
  return { onOpen, onBlast, user };
}

describe("the OCP version distribution", () => {
  it("draws a bar per version with the clusters on it", async () => {
    open();
    expect(await screen.findByText("4.16.7")).toBeInTheDocument();
    expect(screen.getByText("· 3 clusters")).toBeInTheDocument();
    expect(screen.getAllByText("· 1 cluster")).toHaveLength(2);       // singular
    expect(screen.getByText("ocp-stage-iad-01")).toBeInTheDocument();
  });

  it("opens a cluster from its chip", async () => {
    const { onOpen, user } = open();
    await user.click(await screen.findByText("ocp-prod-sjc-01"));
    expect(onOpen).toHaveBeenCalledWith("ocp-prod-sjc-01");
  });

  it("asks for the blast radius of a version", async () => {
    const { onBlast, user } = open();
    const row = (await screen.findByText("4.15.22")).closest("div");
    await user.click(within(row.parentElement).getByText("blast radius →"));
    expect(onBlast).toHaveBeenCalledWith("4.15.22");
  });

  it("stands the distribution in while it is on the wire", () => {
    answer(api, { versions: () => new Promise(() => {}) });
    const { container } = { container: document.body, ...open() };
    expect(container.querySelector(".skeleton-lines")).toBeInTheDocument();
  });

  it("shows nothing but the error when versions cannot be read", async () => {
    answer(api, { versions: fails("500 Internal Server Error") });
    open();
    expect(await screen.findByText(/500 Internal Server Error/)).toBeInTheDocument();
    expect(screen.queryByText("Operator version spread")).toBeNull();
  });
});

describe("the operator version spread", () => {
  it("lists only the operators that are actually drifting", async () => {
    open();
    expect(await screen.findByText("ingress")).toBeInTheDocument();
    expect(screen.getByText("network")).toBeInTheDocument();
    expect(screen.queryByText("authentication")).toBeNull();
  });

  it("names every version in the fleet and how many carry it", async () => {
    open();
    const row = (await screen.findByText("ingress")).closest("tr");
    expect(within(row).getByText("4.16.7 (4), 4.15.22 (1)")).toBeInTheDocument();
  });

  it("says so when nothing is drifting", async () => {
    answer(api, { operatorVersions: { operators: [
      { operator: "authentication", distinct: 1, versions: [{ version: "4.16.7", count: 5 }] }] } });
    open();
    expect(await screen.findByText("All operators are on a single version across the fleet."))
      .toBeInTheDocument();
  });

  it("shows the operator failure without losing the version distribution", async () => {
    answer(api, { operatorVersions: fails("404 Not Found") });
    open();
    expect(await screen.findByText(/404 Not Found/)).toBeInTheDocument();
    expect(screen.getByText("4.16.7")).toBeInTheDocument();
  });
});
