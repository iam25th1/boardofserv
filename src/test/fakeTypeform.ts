import type { FakeNet } from "./fakeNet";

// Typeform's API as tests see it: one form with its questions and
// responses, answered for one token; every request kept. The data is made
// up: fictional projects, links on example.com.

export const FAKE_TYPEFORM_TOKEN = "tfp_test_token_for_the_fake_typeform";
export const FAKE_FORM_ID = "FakeForm01";
export const FAKE_FORM_LINK = `https://form.typeform.com/to/${FAKE_FORM_ID}`;

const FIELDS = [
  { id: "f_name", ref: "project_name", title: "Project name", type: "short_text" },
  { id: "f_team", ref: "team_name", title: "Team name", type: "short_text" },
  { id: "f_track", ref: "track", title: "Track", type: "multiple_choice" },
  { id: "f_desc", ref: "description", title: "Description", type: "long_text" },
  { id: "f_demo", ref: "demo_link", title: "Demo link", type: "website" },
  { id: "f_repo", ref: "repo_link", title: "Repo link", type: "website" },
];

type Entry = { name: string; team?: string; track?: string; description?: string; demo?: string; repo?: string };

export const FAKE_ENTRIES: Entry[] = [
  { name: "Tidewatch", team: "Low Tide Labs", track: "Dolphin", description: "Plans safe tide-pool visits for school groups from the local tide table. Demo with three beaches; repo with 41 passing tests.", demo: "https://example.com/tidewatch/demo", repo: "https://example.com/tidewatch/repo" },
  { name: "Shelf Life", team: "Pantry Crew", track: "Reppo", description: "Tracks a food bank's stock by expiry date and says what to hand out first. Seeded demo warehouse; repo with tests and CI.", demo: "https://example.com/shelf-life/demo", repo: "https://example.com/shelf-life/repo" },
  { name: "Commute Buddy", team: "Two Coders", track: "Open", description: "Compares bus and bike times to work for one city with fixed data. No tests yet.", demo: "https://example.com/commute-buddy" },
  { name: "Recipe Remix", track: "Dolphin", description: "Makes a lighter version of a pasted recipe. Works for simple ones.", repo: "https://example.com/recipe-remix" },
  { name: "Something with AI", team: "TBD", track: "Open", description: "We want to use AI to make life easier. Still deciding what it does." },
  { name: "Moonshot" },
];

function responseOf(e: Entry, i: number) {
  const answers = [
    { field: { id: "f_name", type: "short_text" }, type: "text", text: e.name },
    ...(e.team ? [{ field: { id: "f_team", type: "short_text" }, type: "text", text: e.team }] : []),
    ...(e.track ? [{ field: { id: "f_track", type: "multiple_choice" }, type: "choice", choice: { label: e.track } }] : []),
    ...(e.description ? [{ field: { id: "f_desc", type: "long_text" }, type: "text", text: e.description }] : []),
    ...(e.demo ? [{ field: { id: "f_demo", type: "website" }, type: "url", url: e.demo }] : []),
    ...(e.repo ? [{ field: { id: "f_repo", type: "website" }, type: "url", url: e.repo }] : []),
  ];
  return { response_id: `resp${i + 1}`, token: `resp${i + 1}`, submitted_at: new Date(Date.UTC(2026, 10, 13, 9, i)).toISOString(), answers };
}

// Serves the fake form on the fake net; returns what was asked of it.
export function fakeTypeform(net: FakeNet, entries: Entry[] = FAKE_ENTRIES): { paths: string[]; entries: Entry[] } {
  const state = { paths: [] as string[], entries };
  net.on("https://api.typeform.com/", (req) => {
    state.paths.push(req.url.pathname + req.url.search);
    if (req.headers.get("authorization") !== `Bearer ${FAKE_TYPEFORM_TOKEN}`) return Response.json({ code: "AUTHENTICATION_FAILED" }, { status: 401 });
    if (req.url.pathname === "/me") return Response.json({ alias: "sample-maker", language: "en" });
    if (req.url.pathname === `/forms/${FAKE_FORM_ID}`) return Response.json({ id: FAKE_FORM_ID, title: "Sample hackathon submissions", fields: FIELDS });
    if (req.url.pathname === `/forms/${FAKE_FORM_ID}/responses`) return Response.json({ total_items: state.entries.length, page_count: 1, items: state.entries.map(responseOf) });
    return Response.json({ code: "FORM_NOT_FOUND" }, { status: 404 });
  });
  return state;
}
