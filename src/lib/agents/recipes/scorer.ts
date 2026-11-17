import type { AgentDefinition } from "../definition";
import { emptyBench } from "../types";
import { literal, type Recipe, type RecipeFill } from "./types";

// Score each new form response or sheet row with SERV against the owner's
// criteria, and send one summary: the Typeform scorer and the hackathon
// sheet scorer that went live (PR #2 to #4's Typeform source; the live
// Hackathon Submission Scorer). A sheet's rows get their Score and Reasons
// written back, so the next run leaves them alone; a form's responses are
// each taken once by typeform.read.

const nameOf = [
  "  const nameOf = function (x) {",
  '    const skip = { id: 1, submittedAt: 1, _row: 1, Score: 1, Reasons: 1 };',
  "    for (const k of Object.keys(x)) {",
  '      const v = x[k];',
  '      if (!skip[k] && typeof v === "string" && v.trim() && v.length <= 80) return v.trim();',
  "    }",
  '    return String(x.id || x._row || "item");',
  "  };",
];

const scoreCode = (task: string, list: string, rowKey: string) =>
  [
    "async function run(input, tools) {",
    '  const criteria = String((input.settings || {}).criteria || "").trim();',
    `  const items = Array.isArray(input.${list}) ? input.${list} : [];`,
    ...nameOf,
    "  const results = [];",
    "  for (const item of items) {",
    "    const judged = await tools.serv.reason({",
    `      task: ${literal(task)},`,
    "      data: { criteria: criteria, item: item },",
    '      answer: { score: "number", reasons: "text" },',
    "    });",
    `    results.push({ ${rowKey}name: nameOf(item), score: Math.max(1, Math.min(10, Math.round(Number(judged.score) || 1))), reasons: String(judged.reasons || "") });`,
    "  }",
    "  return { results: results };",
    "}",
  ].join("\n");

const summaryCode = (noun: string) =>
  [
    "async function run(input) {",
    "  const results = (Array.isArray(input.results) ? input.results : []).slice().sort(function (a, b) { return b.score - a.score; });",
    "  if (!results.length) return { message: null };",
    `  const head = results.length + " " + ${literal(noun)} + (results.length === 1 ? "" : "s") + " scored:";`,
    '  const lines = results.map(function (r) { return r.name + ": " + r.score + "/10. " + r.reasons; });',
    '  return { message: { text: [head].concat(lines).join("\\n").slice(0, 3500) } };',
    "}",
  ].join("\n");

const readFormCode = [
  "async function run(input, tools) {",
  '  const form = String((input.settings || {}).form || "").trim();',
  "  if (!form) return { responses: [] };",
  "  const got = await tools.typeform.read({ form: form });",
  "  return { responses: got && Array.isArray(got.responses) ? got.responses : [] };",
  "}",
].join("\n");

const readRowsCode = [
  "async function run(input, tools) {",
  '  const sheet = (input.settings || {}).sheet;',
  "  if (!sheet) return { rows: [] };",
  "  const got = await tools.sheets.read({ sheet: sheet });",
  "  const all = got && Array.isArray(got.rows) ? got.rows : [];",
  '  return { rows: all.filter(function (r) { return r.Score === undefined || r.Score === null || String(r.Score).trim() === ""; }).slice(0, 10) };',
  "}",
].join("\n");

const writeScoresCode = [
  "async function run(input) {",
  "  const results = Array.isArray(input.results) ? input.results : [];",
  "  if (!results.length) return { scores: null };",
  "  return { scores: { sheet: (input.settings || {}).sheet, updates: results.map(function (r) { return { row: r.row, values: { Score: r.score, Reasons: r.reasons } }; }) } };",
  "}",
].join("\n");

const CRITERIA = { key: "criteria", label: "What it scores them on", type: "text", help: "Your criteria, in your own words: what makes a good one.", choices: [] };

export const scorer: Recipe = {
  id: "scorer",
  fits: "score each new form response or sheet row (a submission, an application, an enquiry) from 1 to 10 against the owner's criteria with SERV, and send one summary",
  asks: { form: "the Typeform form's link (form variant)", sheet: "the Google Sheet tab (sheet variant)", criteria: "what it scores them on, in the owner's words" },
  uses: ["typeform", "google"],
  variants: [
    { id: "form", says: "new responses to a Typeform form" },
    { id: "sheet", says: "new rows of a Google Sheet, with Score and Reasons written back" },
  ],
  task: { says: "how SERV scores each one, in the maker's terms", byDefault: () => "Score this one from 1 to 10 against the criteria, with reasons that name what it has and what it lacks." },
  build(f: RecipeFill) {
    const sheet = f.variant === "sheet";
    const given = (key: string) => (f.given[key] ? { given: f.given[key] } : {});
    const tell = { id: "send", kind: "action", title: "Send it to you", plain: "Send the summary to you on Telegram.", action: "tell", inputs: ["message"], outputs: [], next: null };
    const summary = (next: string) => ({
      id: "write_summary",
      kind: "code",
      title: "List the scores",
      plain: "Put together one message naming each one with its score.",
      description: "Fill in one message from the results, best first: each one's name, score out of 10 and reasons. Return message, telegram.send's arguments { text }.",
      inputs: ["results"],
      outputs: ["message"],
      shapes: { message: "{ text: text }" },
      tools: [],
      next,
    });
    const score = (list: string, next: string) => ({
      id: "score_each",
      kind: "code",
      title: "Score each one",
      plain: "Ask SERV to score each one against your criteria.",
      description: `Go through ${list} one at a time and ask SERV with serv.reason to score each from 1 to 10 against settings.criteria, with answer { score: number, reasons: text }, one call each. Return results, one per item, with ${sheet ? "row (its _row), " : ""}name, score and reasons.`,
      inputs: [list, "settings"],
      outputs: ["results"],
      shapes: { results: sheet ? "{ row: number, name: text, score: number, reasons: text }[]" : "{ name: text, score: number, reasons: text }[]" },
      tools: ["serv.reason"],
      next,
    });
    const definition = sheet
      ? {
          settings: [{ key: "sheet", label: "Which sheet holds them", type: "sheet", help: "One row each. It writes Score and Reasons into each row it scores.", choices: [], ...given("sheet") }, { ...CRITERIA, ...given("criteria") }],
          steps: [
            { id: "read_rows", kind: "code", title: "Read the new rows", plain: "Read the rows of your sheet that have no score yet.", description: "Read the sheet in settings.sheet with sheets.read and return rows: those whose Score column is still empty, at most 10, each with its _row.", inputs: ["settings"], outputs: ["rows"], tools: ["sheets.read"], next: "score_each" },
            score("rows", "write_scores"),
            { id: "write_scores", kind: "code", title: "Prepare the scores", plain: "Put each score and its reasons in the row it belongs to.", description: "Return scores, sheets.update's arguments { sheet: settings.sheet, updates }, one update per result, its row the result's row, its values { Score, Reasons }.", inputs: ["results", "settings"], outputs: ["scores"], shapes: { scores: "{ sheet: text, updates: { row: number, values: { Score: number, Reasons: text } }[] }" }, tools: [], next: "save_scores" },
            { id: "save_scores", kind: "action", title: "Write them into your sheet", plain: "Write each score and its reasons into its row.", action: "save", inputs: ["scores"], outputs: [], next: "write_summary" },
            summary("send"),
            tell,
          ],
          actions: [
            { id: "save", tool: "sheets.update", description: "Write each score and its reasons into your sheet" },
            { id: "tell", tool: "telegram.send", description: "Send you the summary" },
          ],
        }
      : {
          settings: [{ key: "form", label: "Your Typeform form's link", type: "url", help: "The form whose responses it scores; you connect Typeform at setup.", choices: [], ...given("form") }, { ...CRITERIA, ...given("criteria") }],
          steps: [
            { id: "read_responses", kind: "code", title: "Read the new responses", plain: "Read your form's new responses.", description: "Read the new responses to the form in settings.form with typeform.read and return responses.", inputs: ["settings"], outputs: ["responses"], tools: ["typeform.read"], next: "score_each" },
            score("responses", "write_summary"),
            summary("send"),
            tell,
          ],
          actions: [{ id: "tell", tool: "telegram.send", description: "Send you the summary" }],
        };
    return {
      definition: { format: 1, name: f.name, job: { does: f.does, done: f.done }, triggers: [f.trigger], rules: [], memory: [], limits: { maxSteps: 40, maxRunSeconds: 300, maxSpendUsd: 0.1 }, ...definition },
      code: (sheet
        ? { read_rows: readRowsCode, score_each: scoreCode(f.task, "rows", "row: item._row, "), write_scores: writeScoresCode, write_summary: summaryCode("row") }
        : { read_responses: readFormCode, score_each: scoreCode(f.task, "responses", ""), write_summary: summaryCode("response") }) as Record<string, string>,
    };
  },
  sample(d: AgentDefinition) {
    const bench = emptyBench();
    const setting = (k: string) => d.settings.find((s) => s.key === k)?.given;
    bench.settings.criteria = setting("criteria") ?? "A clear idea, a working demo, and a README.";
    const people = [
      { name: "Tide", about: "A tide alert bot with a public demo, a README and tests." },
      { name: "Notes", about: "One word." },
      { name: "Ledgerly", about: "A budgeting sheet helper, demo coming soon, short README." },
    ];
    if (d.settings.some((s) => s.key === "sheet")) {
      const tab = setting("sheet") ?? "Submissions";
      bench.settings.sheet = tab;
      bench.sheets[tab] = people.map((p) => ({ Name: p.name, Description: p.about, Score: "", Reasons: "" }));
    } else {
      const form = setting("form") ?? "https://form.typeform.com/to/Sample01";
      bench.settings.form = form;
      bench.forms = { [form]: people.map((p, i) => ({ id: `resp${i + 1}`, submittedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(), project_name: p.name, description: p.about })) };
    }
    return { bench, items: { noun: "submission", plural: "submissions", labels: people.map((p) => p.name) } };
  },
};
