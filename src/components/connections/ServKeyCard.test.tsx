import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ServKeyCard } from "./ServKeyCard";

// The owner's own SERV key on Connections, where a free agent's budget card
// sends them: it says what the key changes, takes one, and removes it.

afterEach(cleanup);

describe("your SERV key on Connections", () => {
  it("says a free agent's allowance caps it without one, and saves the key pasted", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<ServKeyCard servKey={null} onSave={onSave} onRemove={vi.fn()} />);
    expect(container.querySelector("#serv-key")).not.toBeNull();
    expect(screen.getByText(/up to a small allowance each week, and the agent pauses when that runs out/)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Use my key" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Paste your SERV key"), { target: { value: "  sk-test-1234  " } });
    fireEvent.click(save);
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("sk-test-1234"));
  });

  it("shows only the key's last four once in use, and removes it", async () => {
    const onRemove = vi.fn().mockResolvedValue(undefined);
    render(<ServKeyCard servKey={{ last4: "a1b2" }} onSave={vi.fn()} onRemove={onRemove} />);
    expect(screen.getByText("in use, ending a1b2")).toBeInTheDocument();
    expect(screen.queryByLabelText("Paste your SERV key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove it" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledTimes(1));
  });

  it("says why a key wasn't taken", async () => {
    render(<ServKeyCard servKey={null} onSave={vi.fn().mockRejectedValue(new Error("SERV turned that key down."))} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Paste your SERV key"), { target: { value: "sk-bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Use my key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SERV turned that key down.");
  });
});
