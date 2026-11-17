import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InstallationDTO } from "@/lib/types";
import { NewerVersion, OtherCopies } from "./InstallationControls";

// The running card says when a newer version of the owner's own agent is
// ready, with one line on what changed and Switch.

afterEach(cleanup);

const card = (newer: InstallationDTO["newer"]) => ({ id: "inst-1", agentId: "agent-1", version: 1, status: "active", newer }) as InstallationDTO;

describe("a newer version on the running card", () => {
  it("says Version N is ready, what changed, and switches to it", async () => {
    const onSwitch = vi.fn().mockResolvedValue(undefined);
    render(<NewerVersion data={card({ version: 3, line: 'New or changed: "Judge each commit".', breaking: null })} onSwitch={onSwitch} />);
    expect(screen.getByRole("status")).toHaveTextContent('Version 3 is ready. New or changed: "Judge each commit".');
    fireEvent.click(screen.getByRole("button", { name: "Switch to version 3" }));
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1));
  });

  it("points to setting it up when it asks something new, and shows nothing without a newer one", () => {
    const { rerender } = render(<NewerVersion data={card({ version: 2, line: "It asks you for \"Repository\" at setup.", breaking: 'It asks something new at setup ("Repository").' })} onSwitch={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("link", { name: "Set version 2 up" })).toHaveAttribute("href", "/app/agents/agent-1?setup=1");
    // Setting it up takes this copy over: no second one to stop after.
    expect(screen.getByRole("status")).toHaveTextContent("this copy takes it over");
    rerender(<NewerVersion data={card(null)} onSwitch={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("other copies running beside it", () => {
  const copies = (others: number, status = "active") => ({ id: "inst-1", agentId: "agent-1", version: 1, status, newer: null, others }) as InstallationDTO;

  it("says how many run beside it and stops them once the owner confirms, keeping this one", async () => {
    const onStop = vi.fn().mockResolvedValue(undefined);
    render(<OtherCopies data={copies(2)} onStop={onStop} />);
    expect(screen.getByRole("status")).toHaveTextContent("2 other copies of this agent run beside this one, doing the same job");
    fireEvent.click(screen.getByRole("button", { name: "Stop the other copies" }));
    expect(onStop).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Stop them" }));
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
  });

  it("shows nothing with no other copy, or on a stopped one", () => {
    const { rerender } = render(<OtherCopies data={copies(0)} onStop={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<OtherCopies data={copies(1, "stopped")} onStop={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
    rerender(<OtherCopies data={copies(1)} onStop={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Another copy of this agent runs beside this one");
  });
});
