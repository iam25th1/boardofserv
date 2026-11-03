// The parts of scripts/db-lockdown.sh that read or write DATABASE_URL, which
// holds the database password. No command here ever prints a password:
// they report what they did, password-sql refuses to write to a terminal,
// and error messages are scrubbed of any password they read.
//
//   describe <env file>                user, host, port and database name
//   write-new-url <env file> <out>     the same URL with the password read
//                                      from stdin, into a new 0600 file
//   password-sql <env file>            the SQL that sets the URL's password
//                                      on its role, for piping into psql
//   check-url <env file>               signs in with the URL, as the app does
//   set-env-file <env file> <url file> replaces the DATABASE_URL line, and
//                                      only that line
//   pier-check <env file>              the Pier service's DATABASE_URL is the
//                                      one in the env file (by length and
//                                      Pier's masked preview)
//   pier-set <url file>                replaces the Pier service's
//                                      DATABASE_URL and keeps every other value
//
// Pier: the session comes from ~/.pier/agent/src/core/auth.js, the way the
// pier CLI makes its own (owning ~/.pier/auth.json is the authority).
// BOS_PIER_SERVICE, PIER_AGENT_DIR and PIER_API exist to rehearse against a
// stand-in; leave them unset.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "DATABASE_URL";
// PUT /api/projects/:id/env resolves this against the stored value
// (~/.pier/agent/src/routes/api.js), so the other values never leave Pier.
export const PIER_KEEP = "__PIER_KEEP__";

const LINE = /^(\s*(?:export\s+)?DATABASE_URL\s*=\s*)(["']?)(.*?)\2\s*$/;
const secrets = new Set();

/** The one DATABASE_URL line in an env file. */
export function findDatabaseUrl(text) {
  const hits = [];
  text.split("\n").forEach((line, index) => {
    const m = LINE.exec(line.replace(/\r$/, ""));
    if (m) hits.push({ index, prefix: m[1], quote: m[2], value: m[3] });
  });
  if (hits.length !== 1) throw new Error(`expected one ${KEY} line, found ${hits.length}`);
  return hits[0];
}

/** The env file with its DATABASE_URL line, and nothing else, changed. */
export function replaceDatabaseUrl(text, url) {
  const hit = findDatabaseUrl(text);
  const lines = text.split("\n");
  const cr = lines[hit.index].endsWith("\r") ? "\r" : "";
  lines[hit.index] = `${hit.prefix}${hit.quote}${url}${hit.quote}${cr}`;
  return lines.join("\n");
}

function parse(url) {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new Error(`${KEY} is not a postgres:// URL`);
  if (u.password) secrets.add(decodeURIComponent(u.password));
  return u;
}

/** The same URL with another password. */
export function withPassword(url, password) {
  const u = parse(url);
  u.password = encodeURIComponent(password);
  return u.toString();
}

/** User, host, port and database name: nothing secret. */
export function describeUrl(url) {
  const u = parse(url);
  return {
    user: decodeURIComponent(u.username),
    host: u.hostname,
    port: u.port || "5432",
    db: decodeURIComponent(u.pathname.replace(/^\//, "")),
  };
}

/** SQL that sets the URL's password on its role, kept out of the server log. */
export function passwordSql(url) {
  const u = parse(url);
  const role = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  if (!role || !password) throw new Error(`${KEY} has no user or no password`);
  return [
    // A logged statement, or an error that quotes it, would put the password
    // in the container's log. This session logs neither.
    "SET log_statement = 'none';",
    "SET log_min_error_statement = 'panic';",
    "SET log_min_duration_statement = -1;",
    "SET password_encryption = 'scram-sha-256';",
    `ALTER ROLE "${role.replace(/"/g, '""')}" WITH PASSWORD '${password.replace(/'/g, "''")}';`,
    "",
  ].join("\n");
}

/** What Pier shows of a value (~/.pier/agent/src/core/secrets.js). */
export function pierMask(value) {
  if (!value) return "";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${value.slice(0, 2)}${"•".repeat(Math.min(12, value.length - 4))}${value.slice(-2)}`;
}

function readUrl(file) {
  return findDatabaseUrl(fs.readFileSync(file, "utf8")).value;
}

function readStdin() {
  return fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
}

// One Pier session per command, destroyed when it is done: Pier keeps only
// its ten newest sessions, so each one made can sign the dashboard out.
async function withPier(fn) {
  const agent = process.env.PIER_AGENT_DIR || path.join(os.homedir(), ".pier", "agent");
  const auth = await import(pathToFileURL(path.join(agent, "src", "core", "auth.js")).href);
  const base = new URL(process.env.PIER_API || "http://127.0.0.1:7433");
  const token = auth.createSession();
  const call = (method, apiPath, body) =>
    new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request(
        {
          host: base.hostname,
          port: base.port,
          path: `/api${apiPath}`,
          method,
          timeout: 15000,
          headers: {
            host: base.host,
            "content-type": "application/json",
            "x-pier-request": "1",
            cookie: `pier_session=${encodeURIComponent(token)}`,
            ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (raw += c));
          res.on("end", () => {
            let parsed;
            try {
              parsed = JSON.parse(raw);
            } catch {
              return reject(new Error(`Pier answered HTTP ${res.statusCode}`));
            }
            if (res.statusCode >= 400) return reject(new Error(`Pier: ${parsed.error || `HTTP ${res.statusCode}`}`));
            resolve(parsed);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("Pier did not answer")));
      req.on("error", (err) => reject(new Error(`cannot reach Pier at ${base.host} (${err.message})`)));
      if (payload) req.write(payload);
      req.end();
    });
  try {
    return await fn(call);
  } finally {
    auth.destroySession(token);
  }
}

async function pierService(call) {
  const slug = process.env.BOS_PIER_SERVICE || "boardofserv";
  const { projects } = await call("GET", "/projects");
  const project = projects.find((p) => p.slug === slug);
  if (!project) throw new Error(`Pier has no service named ${slug}`);
  const { keys } = await call("GET", `/projects/${project.id}/env`);
  return { slug, project, keys };
}

const commands = {
  describe(envFile) {
    const d = describeUrl(readUrl(envFile));
    console.log(`${d.user} ${d.host} ${d.port} ${d.db}`);
  },

  "write-new-url"(envFile, out) {
    const password = readStdin();
    secrets.add(password);
    if (password.length < 32) throw new Error("the new password on stdin is too short");
    fs.writeFileSync(out, `${KEY}=${withPassword(readUrl(envFile), password)}\n`, { mode: 0o600, flag: "wx" });
    console.log(`new ${KEY} kept in ${out} (owner only) until the lockdown finishes`);
  },

  "password-sql"(envFile) {
    if (process.stdout.isTTY) throw new Error("password-sql writes a password: pipe it into psql, never to a terminal");
    process.stdout.write(passwordSql(readUrl(envFile)));
  },

  async "check-url"(envFile) {
    const pg = createRequire(path.join(ROOT, "package.json"))("pg");
    const client = new pg.Client({ connectionString: readUrl(envFile), connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      const { rows } = await client.query("select current_user as role");
      console.log(`signed in as ${rows[0].role}`);
    } finally {
      await client.end();
    }
  },

  "set-env-file"(envFile, urlFile) {
    const target = fs.realpathSync(envFile);
    const before = fs.readFileSync(target, "utf8");
    const after = replaceDatabaseUrl(before, readUrl(urlFile));
    const a = before.split("\n");
    const b = after.split("\n");
    const changed = a.filter((line, i) => line !== b[i]).length;
    if (a.length !== b.length || changed !== 1) throw new Error(`expected to change one line of ${envFile}, would change ${changed}`);
    const mode = fs.statSync(target).mode & 0o777;
    const tmp = `${target}.lockdown-${process.pid}`;
    fs.writeFileSync(tmp, after, { mode, flag: "wx" });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
    console.log(`${envFile}: ${KEY} replaced, no other line changed`);
  },

  async "pier-check"(envFile) {
    const url = readUrl(envFile);
    const { slug, project, keys } = await withPier(pierService);
    const stored = keys.find((k) => k.key === KEY);
    if (!stored) throw new Error(`Pier service ${slug} has no ${KEY}`);
    if (stored.length !== url.length || stored.preview !== pierMask(url)) {
      throw new Error(`Pier service ${slug} has a ${KEY} that is not the one in ${envFile}`);
    }
    console.log(`Pier service ${slug} (${project.id}): ${keys.length} values, its ${KEY} matches ${envFile}`);
  },

  async "pier-set"(urlFile) {
    const url = readUrl(urlFile);
    const { slug, keys, after } = await withPier(async (call) => {
      const { slug, project, keys } = await pierService(call);
      if (!keys.some((k) => k.key === KEY)) throw new Error(`Pier service ${slug} has no ${KEY}`);
      const env = Object.fromEntries(keys.map((k) => [k.key, PIER_KEEP]));
      env[KEY] = url;
      const { keys: after } = await call("PUT", `/projects/${project.id}/env`, { env });
      return { slug, keys, after };
    });
    const was = new Map(keys.map((k) => [k.key, k]));
    const now = after.find((k) => k.key === KEY);
    const kept = after.filter((k) => k.key !== KEY && was.get(k.key)?.length === k.length && was.get(k.key)?.preview === k.preview);
    if (after.length !== keys.length || kept.length !== keys.length - 1 || now?.length !== url.length || now?.preview !== pierMask(url)) {
      throw new Error(`Pier service ${slug}: the environment did not come back as expected; check it in the dashboard`);
    }
    console.log(`Pier service ${slug}: ${KEY} replaced, the other ${kept.length} values kept`);
  },
};

function scrub(message) {
  let out = String(message);
  for (const s of secrets) if (s) out = out.split(s).join("***");
  return out;
}

async function main([name, ...args]) {
  const command = commands[name];
  if (!command) throw new Error(`unknown command ${name ?? "(none)"}`);
  await command(...args);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`db-lockdown: ${scrub(err?.message ?? err)}`);
    process.exit(1);
  });
}
