import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InstallationDTO } from "@/lib/types";
import { NewerVersion } from "./InstallationControls";

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
    rerender(<NewerVersion data={card(null)} onSwitch={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
