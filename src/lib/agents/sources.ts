// Sources an agent can't read with what it was given. A form's public link
// opens the form, not the answers people send; a page behind a sign-in
// shows the sign-in. An agent told to read one would read nothing and go
// on as if it had (the live Hackathon Submission Scorer "read" a Typeform
// link in 5 ms and scored the link). So such a link is named for what it
// is, in plain words: in the chat when the maker gives it, as the reason a
// step that tries to read it fails, and never planned as a step that
// pretends to read it.

export interface SourceProblem {
  // What it is: "a Typeform form link".
  what: string;
  // The connection that makes it readable (typeform.read with the owner's
  // own token), when there is one.
  via?: "typeform";
  // Why it can't be read, what reading it would take, and what works.
  why: string;
  needs: string;
  instead: string;
}

const FORM = (name: string, needs: string, instead: string): SourceProblem => ({
  what: `a ${name} form link`,
  why: `A ${name} link opens the form, not the answers people send, so an agent can't read submissions from it.`,
  needs,
  instead,
});

const SIGN_IN = (name: string, instead: string, what = `a ${name} page`): SourceProblem => ({
  what,
  why: `${name} shows that page only to someone signed in, so an agent fetching it gets the sign-in page, not what's on it.`,
  needs: `Reading it would need your own ${name} sign-in, which agents here never take.`,
  instead,
});

// What works instead, for a form: its answers in a Google Sheet, which an
// agent reads like any other sheet.
const IN_A_SHEET = "give me that sheet when you set it up, and it reads each new answer as a row";

const RULES: { host: RegExp; path?: RegExp; problem: SourceProblem }[] = [
  {
    host: /(^|\.)typeform\.com$/,
    problem: {
      ...FORM(
        "Typeform",
        "To read its answers I need your Typeform personal token: connect Typeform and I'll read each new answer from the form, each one once.",
        `Or, without a token: in your form's Connect tab, turn on Google Sheets so each answer lands in a sheet, then ${IN_A_SHEET}.`,
      ),
      via: "typeform",
    },
  },
  { host: /^forms\.gle$/, problem: FORM("Google Forms", "Reading the answers needs the sheet the form's responses go to.", `In the form's Responses tab, choose Link to Sheets, then ${IN_A_SHEET}.`) },
  { host: /^docs\.google\.com$/, path: /^\/forms\//, problem: FORM("Google Forms", "Reading the answers needs the sheet the form's responses go to.", `In the form's Responses tab, choose Link to Sheets, then ${IN_A_SHEET}.`) },
  { host: /^forms\.(?:office|microsoft)\.com$/, problem: FORM("Microsoft Forms", "Reading the answers needs them in a sheet.", `Open the responses in Excel, save them as a Google Sheet, then ${IN_A_SHEET}.`) },
  { host: /(^|\.)tally\.so$/, problem: FORM("Tally", "Reading the answers needs your Tally API key, or a webhook from Tally.", `Simplest: turn on Tally's Google Sheets integration, then ${IN_A_SHEET}.`) },
  { host: /(^|\.)jotform\.com$/, problem: FORM("Jotform", "Reading the answers needs your Jotform API key, or a webhook from Jotform.", `Simplest: turn on Jotform's Google Sheets integration, then ${IN_A_SHEET}.`) },
  { host: /^airtable\.com$/, problem: FORM("Airtable", "Reading the records needs an Airtable token.", `Export the table to a Google Sheet, then ${IN_A_SHEET}.`) },
  { host: /^(?:mail|drive)\.google\.com$/, problem: SIGN_IN("Google", "Put what it should read in a Google Sheet and give me that sheet instead.") },
  { host: /^docs\.google\.com$/, path: /^\/(?:document|presentation)\//, problem: SIGN_IN("Google Docs", "Publish it to the web (File, Share, Publish to web) and give me that link, or put what it should read in a Google Sheet.") },
  { host: /(^|\.)(?:linkedin|facebook|instagram)\.com$/, problem: SIGN_IN("That site", "Give me a public page, a web search, or a Google Sheet with what it should read instead.", "a page behind a sign-in") },
  { host: /(^|\.)slack\.com$/, problem: SIGN_IN("Slack", "Put what it should read in a Google Sheet instead.") },
];

// What is wrong with reading this link, or null for a link an agent can
// read (a public page, an API answering without a key).
export function sourceProblem(url: string): SourceProblem | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const rule = RULES.find((r) => r.host.test(host) && (!r.path || r.path.test(u.pathname)));
  return rule?.problem ?? null;
}

const LINK = /\bhttps?:\/\/[^\s"'<>)\]}]+/gi;

// The first link in some text an agent couldn't read with what its owner
// has connected, with its problem: a Typeform link reads once Typeform is.
export function unreadableIn(text: string, connected: ReadonlySet<string> = new Set()): { url: string; problem: SourceProblem } | null {
  for (const m of text.match(LINK) ?? []) {
    const url = m.replace(/[.,;:!?]+$/, "");
    const problem = sourceProblem(url);
    if (problem && !(problem.via && connected.has(problem.via))) return { url, problem };
  }
  return null;
}

// The chat's answer to a maker who gave such a link: what it is, why it
// can't be read, what reading it would take, and what works instead. With
// a connection that reads it, a link to connect it that comes back to here.
export function sourceAsk(p: SourceProblem, connectBack?: string): string {
  const ask = `That's ${p.what}. ${p.why} ${p.needs} ${p.instead}`;
  if (!p.via || !connectBack) return ask;
  return `${ask}\n\n[Connect Typeform](/app/connections?connect=${p.via}&back=${encodeURIComponent(connectBack)})`;
}

// Why a read of it fails, for the step and the job.
export function sourceRefusal(p: SourceProblem): string {
  if (p.via === "typeform") return `It can't read this with web.fetch: ${p.why} Read its answers with typeform.read, with the owner's Typeform connected.`;
  return `It can't read this: ${p.why} ${p.instead}`;
}
