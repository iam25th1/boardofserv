import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AccountDTO } from "@/lib/types";
import { AccountMenu } from "./AccountMenu";

// The handle in the account menu: shown, edited in place, checked live.

const ACCOUNT: AccountDTO = {
  email: "maya@example.com",
  handle: "maker_4821",
  handleChosen: false,
  walletAddress: null,
  openservUserId: null,
  linked: false,
  balance: "unknown",
};

const checkHandle = vi.fn(async (handle: string) => (handle === "maya" ? { available: false, error: "That handle is taken." } : { available: true }));
const onSaveHandle = vi.fn(async () => {});

function open(account = ACCOUNT) {
  render(<AccountMenu account={account} onSignOut={() => {}} checkHandle={checkHandle} onSaveHandle={onSaveHandle} startOpen />);
}

const input = () => screen.getByLabelText("Your handle");
const type = (value: string) => fireEvent.change(input(), { target: { value } });

beforeEach(() => {
  checkHandle.mockClear();
  onSaveHandle.mockReset();
  onSaveHandle.mockResolvedValue(undefined);
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Your handle", () => {
  it("shows the handle, and says when it was picked at random", () => {
    open();
    expect(screen.getByText("@maker_4821")).toBeInTheDocument();
    expect(screen.getByText("picked at random")).toBeInTheDocument();
    cleanup();
    open({ ...ACCOUNT, handle: "maya_r", handleChosen: true });
    expect(screen.getByText("@maya_r")).toBeInTheDocument();
    expect(screen.queryByText("picked at random")).toBeNull();
  });

  it("checks availability while typing", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(input()).toHaveValue("maker_4821");
    expect(input()).toHaveFocus();
    const save = screen.getByRole("button", { name: "Save" });

    // The form is checked at once, without asking the server.
    type("ab");
    expect(screen.getByText("Use 3 to 20 characters.")).toBeInTheDocument();
    type("Admin");
    expect(screen.getByText("That handle is reserved.")).toBeInTheDocument();
    type("maya r");
    expect(screen.getByText("Use only letters, numbers and underscores.")).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(checkHandle).not.toHaveBeenCalled();

    type("maya");
    expect(screen.getByText("Checking...")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("That handle is taken.")).toBeInTheDocument());
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(save).toBeDisabled();

    type("Maya_R");
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());
    expect(checkHandle).toHaveBeenLastCalledWith("maya_r", expect.any(AbortSignal));
    expect(save).toBeEnabled();
  });

  it("saves on Enter, in lower case", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    type("Maya_R");
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());
    await act(async () => {
      fireEvent.submit(input().closest("form")!);
    });
    expect(onSaveHandle).toHaveBeenCalledWith("maya_r");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps the random handle as chosen when saved unchanged", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(onSaveHandle).toHaveBeenCalledWith("maker_4821");
    expect(checkHandle).not.toHaveBeenCalled();
  });

  it("shows why saving failed and stays in the editor", async () => {
    onSaveHandle.mockRejectedValue(new Error("That handle is taken."));
    open();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    type("maya_r");
    await waitFor(() => expect(screen.getByText("Available")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByText("That handle is taken.")).toBeInTheDocument();
    expect(input()).toHaveValue("maya_r");
  });

  it("puts it back on Escape and leaves the menu open", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    type("something_else");
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("@maker_4821")).toBeInTheDocument();
    expect(screen.getByText("Signed in as")).toBeInTheDocument();
  });
});

describe("Your SERV key", () => {
  const onSaveServKey = vi.fn(async (_key: string) => {});
  const onRemoveServKey = vi.fn(async () => {});

  function openWithKey(account: AccountDTO) {
    render(<AccountMenu account={account} onSignOut={() => {}} onSaveServKey={onSaveServKey} onRemoveServKey={onRemoveServKey} startOpen />);
  }

  beforeEach(() => {
    onSaveServKey.mockReset();
    onSaveServKey.mockResolvedValue(undefined);
    onRemoveServKey.mockReset();
    onRemoveServKey.mockResolvedValue(undefined);
  });

  it("offers your own SERV key where linking OpenServ was", () => {
    openWithKey(ACCOUNT);
    expect(screen.getByRole("button", { name: "Use your own SERV key" })).toBeInTheDocument();
    expect(screen.queryByText(/Link your OpenServ account/)).toBeNull();
    expect(screen.queryByText("OpenServ account")).toBeNull();
    // Nothing waits on you for not linking.
    expect(screen.getByRole("button", { name: /^Account/ })).toHaveAttribute("data-needs-you", "false");
  });

  it("takes the key in a masked field and hands it over once, then forgets it", async () => {
    openWithKey(ACCOUNT);
    fireEvent.click(screen.getByRole("button", { name: "Use your own SERV key" }));
    const field = screen.getByLabelText("Your SERV key");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(screen.getByText(/only its last four characters are ever shown/i)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "  sk-own-abcd1234  " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(onSaveServKey).toHaveBeenCalledWith("sk-own-abcd1234");
    expect(screen.queryByLabelText("Your SERV key")).toBeNull();
    expect(screen.queryByDisplayValue("sk-own-abcd1234")).toBeNull();
  });

  it("keeps the field open with the reason when the key is turned away", async () => {
    onSaveServKey.mockRejectedValue(new Error("SERV didn't accept that key. Check it and try again."));
    openWithKey(ACCOUNT);
    fireEvent.click(screen.getByRole("button", { name: "Use your own SERV key" }));
    fireEvent.change(screen.getByLabelText("Your SERV key"), { target: { value: "sk-wrong-key" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("SERV didn't accept that key. Check it and try again.");
    expect(screen.getByLabelText("Your SERV key")).toBeInTheDocument();
  });

  it("shows a saved key by its last four characters, and removes it", async () => {
    openWithKey({ ...ACCOUNT, servKey: { last4: "9f2c" } });
    expect(screen.getByText("Your SERV key")).toBeInTheDocument();
    expect(screen.getByText("9f2c")).toBeInTheDocument();
    expect(screen.getByText(/no daily limit/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use your own SERV key" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(onRemoveServKey).toHaveBeenCalledOnce();
  });

  it("still shows an OpenServ account linked before", () => {
    openWithKey({ ...ACCOUNT, linked: true, openservUserId: "4821", balance: "ok" });
    expect(screen.getByText("OpenServ account")).toBeInTheDocument();
    expect(screen.getByText("Linked (4821)")).toBeInTheDocument();
  });
});
