// Cloudflare entry point for the radar: a cron-triggered Worker that starts the
// Python container, hands it the state from R2, and stores the new state and report back.
import { Container, getContainer } from "@cloudflare/containers";
import page from "./reader.html";
import styles from "./reader.css";
import client from "./reader-client.txt";

// Secrets come from `wrangler secret put` (or the dashboard); they are passed to the
// container as environment variables so the radar reads them the same way it does in CI.
const SECRET_NAMES = [
  "AISA_API_KEY",
  "GOANYAPI_API_KEY",
  "GITHUB_TOKEN",
  "GSC_TOKEN_JSON",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "RADAR_EMAIL_TO",
];

export class RadarContainer extends Container {
  defaultPort = 8080;
  // Stop the instance after 10 minutes idle so it is not billed between runs.
  sleepAfter = "10m";

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = Object.fromEntries(SECRET_NAMES.map((name) => [name, env[name] ?? ""]));
  }
}

const STATE_KEY = "state.tgz";
const REPORT_KEY = "report.md";
const ARCHIVE_PREFIX = "reports/";

function shanghaiDate(time = Date.now()) {
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function archiveReport(bucket, date, kind, report) {
  const prefix = `${ARCHIVE_PREFIX}${date}/`;
  let batch = 1, cursor;
  do {
    const listed = await bucket.list({ prefix, limit: 1000, cursor });
    for (const obj of listed.objects) {
      const match = new RegExp(`/${kind}-(\\d+)\\.md$`).exec(obj.key);
      if (match) batch = Math.max(batch, Number(match[1]) + 1);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  for (let attempt = 0; attempt < 100; attempt++, batch++) {
    const saved = await bucket.put(`${prefix}${kind}-${batch}.md`, report, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    if (saved) return batch;
  }
  throw new Error("could not reserve report batch");
}

function readingHeaders(type) {
  return {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  };
}

function authorized(request, env) {
  if (!env.VIEW_TOKEN) return false;
  const encoder = new TextEncoder();
  const actual = encoder.encode(request.headers.get("Authorization") ?? "");
  const expected = encoder.encode(`Bearer ${env.VIEW_TOKEN}`);
  return actual.length === expected.length && crypto.subtle.timingSafeEqual(actual, expected);
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function runRadar(cmd, env) {
  const stored = await env.STATE.get(STATE_KEY);
  const state = stored ? toBase64(await stored.arrayBuffer()) : "";

  const container = getContainer(env.RADAR_CONTAINER, "radar");
  const res = await container.fetch(
    new Request(`http://container/run?cmd=${cmd}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    }),
  );
  if (!res.ok) throw new Error(`container HTTP ${res.status}`);
  const result = await res.json();

  if (result.exit !== 0) {
    throw new Error(`radar ${cmd} failed with exit ${result.exit}`);
  }
  await env.STATE.put(STATE_KEY, fromBase64(result.state));
  if (result.report) {
    await archiveReport(env.STATE, shanghaiDate(), cmd, result.report);
    await env.STATE.put(REPORT_KEY, result.report);
  }
  const summary = { command: cmd, exit: result.exit, state_saved: true, report_saved: Boolean(result.report) };
  console.log(JSON.stringify(summary));
  return summary;
}

export default {
  async scheduled(event, env, ctx) {
    // One complete daily collection, including X and Hugging Face.
    ctx.waitUntil(runRadar("daily", env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    if (url.pathname === "/") return new Response(page, { headers: readingHeaders("text/html; charset=utf-8") });
    if (url.pathname === "/reader.css") return new Response(styles, { headers: readingHeaders("text/css; charset=utf-8") });
    if (url.pathname === "/reader.js") return new Response(client, { headers: readingHeaders("application/javascript; charset=utf-8") });

    if (url.pathname === "/api/reports") {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
      const objects = [];
      let cursor;
      do {
        const listed = await env.STATE.list({ prefix: ARCHIVE_PREFIX, limit: 1000, cursor });
        objects.push(...listed.objects);
        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);
      const reports = objects.flatMap((obj) => {
        const match = /^reports\/(\d{4}-\d{2}-\d{2})\/(daily|sources)(?:-([1-9]\d*))?\.md$/.exec(obj.key);
        return match ? [{ date: match[1], kind: match[2], batch: Number(match[3] || 0), updatedAt: obj.uploaded.toISOString(), size: obj.size }] : [];
      }).filter((report, _, all) => report.batch > 0 || !all.some(other => other.date === report.date && other.kind === report.kind && other.batch > 0))
        .sort((a, b) => b.date.localeCompare(a.date) || b.batch - a.batch || a.kind.localeCompare(b.kind));
      return Response.json({ reports, cursor: null }, { headers: readingHeaders("application/json; charset=utf-8") });
    }

    if (url.pathname === "/api/report") {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
      const date = url.searchParams.get("date") ?? "";
      const kind = url.searchParams.get("kind") ?? "daily";
      const batch = url.searchParams.get("batch");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !["daily", "sources"].includes(kind) || (batch !== null && !/^[1-9]\d{0,8}$/.test(batch))) {
        return new Response("invalid date or kind", { status: 400 });
      }
      const obj = await env.STATE.get(`${ARCHIVE_PREFIX}${date}/${kind}${batch ? `-${batch}` : ""}.md`);
      if (!obj) return new Response("report not found", { status: 404 });
      return new Response(obj.body, { headers: readingHeaders("text/markdown; charset=utf-8") });
    }

    if (url.pathname === "/run") {
      if (!authorized(request, env)) return new Response("unauthorized", { status: 401 });
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const cmd = url.searchParams.get("cmd");
      if (cmd !== "sources" && cmd !== "daily") return new Response("invalid command", { status: 400 });
      try {
        return Response.json(await runRadar(cmd, env), { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        console.error(`manual ${cmd}: ${error.message}`);
        return Response.json({ command: cmd, error: "radar execution failed" }, { status: 502 });
      }
    }

    // The latest report, behind a bearer token so the leads are not public.
    if (url.pathname === "/report") {
      if (!authorized(request, env)) {
        return new Response("unauthorized", { status: 401 });
      }
      const obj = await env.STATE.get(REPORT_KEY);
      if (!obj) return new Response("no report yet", { status: 404 });
      return new Response(obj.body, { headers: readingHeaders("text/markdown; charset=utf-8") });
    }

    return new Response("not found", { status: 404 });
  },
};
