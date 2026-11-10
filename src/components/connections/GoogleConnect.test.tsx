import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { GoogleConnect } from "./GoogleConnect";

// Right before Google's consent screen: what boardofserv will use, where
// it goes, and that it goes nowhere else, with a way to the details.

afterEach(cleanup);

describe("connecting Google", () => {
  it("says what is used and where it goes before sending you to Google", () => {
    render(<GoogleConnect start={vi.fn(async () => ({ url: "https://accounts.google.com/o/oauth2/v2/auth" }))} />);
    const note = screen.getByText(/Google will ask you to let boardofserv see and edit your Google Sheets/);
    expect(note).toHaveTextContent("see your email address (to show which account is connected)");
    expect(note).toHaveTextContent("only for the jobs you set");
    expect(note).toHaveTextContent("The rows a job reads go to SERV Reasoning");
    expect(note).toHaveTextContent("used to train AI models");
    expect(screen.getByRole("link", { name: "Your data" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("button", { name: "Connect Google" })).toBeInTheDocument();
  });
});
