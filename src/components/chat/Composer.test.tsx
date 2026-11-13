import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer";

// While the agent's steps are worked out, built, tried or fixed, the
// composer has a Stop for that work, and the maker can still type.

afterEach(cleanup);

describe("the composer", () => {
  it("offers Stop for the work on the steps, and still takes a message", () => {
    const onStopWork = vi.fn();
    const onSend = vi.fn();
    render(<Composer conversationKey="c1" busy={false} onSend={onSend} onStop={() => {}} onStopWork={onStopWork} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop working on the steps" }));
    expect(onStopWork).toHaveBeenCalledTimes(1);
    const box = screen.getByRole("textbox", { name: "Message boardofserv" });
    fireEvent.change(box, { target: { value: "Score out of 5 instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSend).toHaveBeenCalledWith("Score out of 5 instead");
  });

  it("has no such Stop when nothing is being worked on", () => {
    render(<Composer conversationKey="c2" busy={false} onSend={() => {}} onStop={() => {}} />);
    expect(screen.queryByRole("button", { name: "Stop working on the steps" })).toBeNull();
  });
});
