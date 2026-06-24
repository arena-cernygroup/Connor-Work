#!/usr/bin/env node
// update-corpus.js — keep Rep. Gary Day's public legislative corpus current.
//
// Reads the palegis.us co-sponsorship-memo list filtered server-side to Rep. Day
// (memberId 1190) — reliably ALL his memos, not a rolling window. For any memo we
// don't already have, fetches the memo page, extracts the full text, writes
// csm/<bill>-<slug>.md, refreshes INDEX.md, and commits (+pushes unless --no-push).
//
// Zero npm dependencies on purpose (office network blocks the npm registry via TLS
// inspection). Run with Node 24's system-CA trust so palegis's intercepted cert is
// trusted the way the browser trusts it:
//
//     node --use-system-ca scripts/update-corpus.js            (commit + push)
//     node --use-system-ca scripts/update-corpus.js --dry-run  (report only)
//     node --use-system-ca scripts/update-corpus.js --no-push  (commit, don't push)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CSM_DIR = join(ROOT, "csm");
const INDEX = join(CSM_DIR, "INDEX.md");

const MEMBER_ID = "1190";
const SESSION_YEAR = "2025";
const LIST_URL = `https://www.palegis.us/house/co-sponsorship/search-results?memberId=${MEMBER_ID}&sessYr=${SESSION_YEAR}`;
const memoUrl = (id) => `https://www.palegis.us/house/co-sponsorship/memo?memoID=${id}`;

const DRY = process.argv.includes("--dry-run");
const NO_PUSH = process.argv.includes("--no-push") || DRY;

// ── helpers ──────────────────────────────────────────────────────────────────
function decode(s = "") {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

function htmlToText(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
}

function usDateToISO(s) {
  // "05/08/2026" -> "2026-05-08"
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || "");
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": "gary-day-leg-corpus updater" } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const stripTags = (s = "") => decode(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));

// ── 1. memos we already have (by memoId in frontmatter) ──────────────────────
function existingMemoIds() {
  const ids = new Set();
  for (const f of readdirSync(CSM_DIR).filter((f) => f.endsWith(".md") && f !== "INDEX.md")) {
    const m = /^memoId:\s*(\d+)/m.exec(readFileSync(join(CSM_DIR, f), "utf8"));
    if (m) ids.add(m[1]);
  }
  return ids;
}

// ── 2. parse the member-filtered memo list into items ────────────────────────
function parseList(html) {
  const byId = new Map(); // dedups the print + screen copies of each memo
  for (const piece of html.split('class="memo-wrapper"').slice(1)) {
    const memoId = (/data-memoid="(\d+)"/.exec(piece) || [])[1];
    if (!memoId || byId.has(memoId)) continue;
    // confirm this block really belongs to member 1190 (defense in depth)
    if (!new RegExp(`/members/bio/${MEMBER_ID}/`).test(piece)) continue;
    const subject = decode(
      (new RegExp(`memo\\?memoID=${memoId}[^>]*>([\\s\\S]*?)<\\/a>`, "i").exec(piece) || [])[1] || ""
    );
    const date = usDateToISO((/Circulated Date:[\s\S]*?col-9[^>]*>([\s\S]*?)<\/div>/.exec(piece) || [])[1] || "");
    const introducedAs = stripTags(
      (/Introduced as[\s\S]*?data-clipboard-cell="4">([\s\S]*?)<\/span>/.exec(piece) || [])[1] || ""
    ).replace(/^introduced as\s*/i, "").trim();
    byId.set(memoId, { memoId, subject, date, introducedAs });
  }
  return [...byId.values()];
}

// ── 3. fetch one memo page and pull subject/date/body ────────────────────────
async function fetchMemo(id) {
  const html = await get(memoUrl(id));
  const subject = decode((/<div class="h1 header-title">([\s\S]*?)<\/div>/.exec(html) || [])[1] || "");
  const pretitle = htmlToText((/<div class="h5 header-pretitle">([\s\S]*?)<\/div>/.exec(html) || [])[1] || "");
  // body: the <div class="mt-3"> immediately after the "Memo" section heading
  const afterMemo = html.split(/>\s*Memo\s*</).slice(1).join(">Memo<");
  const bodyHtml = (/<div class="mt-3">([\s\S]*?)<\/div>/.exec(afterMemo) || [])[1] || "";
  return { subject, pretitle, body: htmlToText(bodyHtml) };
}

// ── 4. write a corpus markdown file ──────────────────────────────────────────
function writeMemoFile(item, memo) {
  const bill = item.introducedAs ? item.introducedAs.replace(/\s+/g, "").toLowerCase() : `memo${item.memoId}`;
  const title = memo.subject || item.subject;
  const filename = `${bill}-${slugify(title)}.md`;
  const path = join(CSM_DIR, filename);
  const fm = [
    "---",
    `memoId: ${item.memoId}`,
    item.introducedAs ? `billNumber: ${item.introducedAs}` : `billNumber: (not yet introduced)`,
    `title: ${title}`,
    `sponsor: Rep. Gary Day (R, HD-187)`,
    `date: ${item.date}`,
    `session: ${SESSION_YEAR}-${Number(SESSION_YEAR) + 1}`,
    `priorities: []   # auto-added — tag during review`,
    `source: ${memoUrl(item.memoId)}`,
    "---",
    "",
    `# ${title}${item.introducedAs ? ` (${item.introducedAs})` : ""}`,
    "",
    memo.pretitle ? `_${memo.pretitle}_\n` : "",
    memo.body || "(body not extracted — verify at source)",
    "",
    "> _Auto-added by update-corpus.js. Position-signal analysis pending review._",
    "",
  ].join("\n");
  if (!DRY) writeFileSync(path, fm);
  return filename;
}

// ── 5. regenerate the INDEX.md table between markers ─────────────────────────
function refreshIndex() {
  const rows = [];
  for (const f of readdirSync(CSM_DIR).filter((f) => f.endsWith(".md") && f !== "INDEX.md")) {
    const t = readFileSync(join(CSM_DIR, f), "utf8");
    const g = (k) => (new RegExp(`^${k}:\\s*(.*)$`, "m").exec(t) || [])[1] || "";
    rows.push({ bill: g("billNumber"), memoId: g("memoId"), title: g("title"), date: g("date") });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  const table = [
    "| Bill | Memo ID | Title | Date |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.bill} | ${r.memoId} | ${r.title} | ${r.date} |`),
  ].join("\n");
  if (existsSync(INDEX)) {
    let idx = readFileSync(INDEX, "utf8");
    if (/<!-- TABLE:START -->[\s\S]*<!-- TABLE:END -->/.test(idx)) {
      idx = idx.replace(/<!-- TABLE:START -->[\s\S]*<!-- TABLE:END -->/, `<!-- TABLE:START -->\n${table}\n<!-- TABLE:END -->`);
      if (!DRY) writeFileSync(INDEX, idx);
    }
  }
}

// ── 6. commit + push ─────────────────────────────────────────────────────────
function commit(added) {
  const subject = `Auto-update corpus: +${added.length} memo(s)`;
  const body = `${added.join("\n")}\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`;
  execSync("git add -A", { cwd: ROOT, stdio: "inherit" });
  // two -m args => subject + body as separate paragraphs (avoids literal \n in message)
  execSync(`git commit -m ${JSON.stringify(subject)} -m ${JSON.stringify(body)}`, { cwd: ROOT, stdio: "inherit" });
  if (!NO_PUSH) execSync("git push", { cwd: ROOT, stdio: "inherit" });
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[corpus] source: ${LIST_URL}`);
  const have = existingMemoIds();
  console.log(`[corpus] already have ${have.size} memo(s): ${[...have].join(", ") || "none"}`);

  const mine = parseList(await get(LIST_URL));
  console.log(`[corpus] member list has ${mine.length} memo(s) from Rep. Day`);

  const fresh = mine.filter((i) => !have.has(i.memoId));
  if (fresh.length === 0) {
    console.log("[corpus] up to date — nothing new.");
    return;
  }

  const added = [];
  for (const item of fresh) {
    const memo = await fetchMemo(item.memoId);
    const filename = writeMemoFile(item, memo);
    added.push(`${item.introducedAs || "memo " + item.memoId}: ${memo.subject || item.subject}`);
    console.log(`[corpus] ${DRY ? "[dry] would add" : "added"} ${filename}`);
  }

  refreshIndex();

  if (DRY) {
    console.log(`[corpus] dry run — ${added.length} new memo(s), no files written, no commit.`);
    return;
  }
  commit(added);
  console.log(`[corpus] done — ${added.length} new memo(s) committed${NO_PUSH ? " (not pushed)" : " and pushed"}.`);
})().catch((e) => {
  console.error("[corpus] ERROR:", e.message);
  process.exit(1);
});
