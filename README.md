# Rep. Gary Day — Legislative Data Corpus

Auto-updating corpus of **public** Pennsylvania legislative data for the office of
**State Rep. Gary Day (R, HD-187, Lehigh County)** — palegis.us member ID **1190**.

This repo is the data layer for **The Briefing Desk**. The app reads it to ground briefings in
where Rep. Day actually stands (his own bills and co-sponsorship memos).

## What's in here

| Folder | Contents | Source |
|---|---|---|
| `csm/` | Co-sponsorship memos he has sponsored (markdown + frontmatter) | palegis.us co-sponsorship memos |
| `bills/` | Metadata for bills he has sponsored/introduced | palegis.us bill pages + `/data` feed |
| `scripts/` | `update-corpus.js` — the auto-updater | — |

Each file carries frontmatter (bill #, memo ID, date, source URL, priority tags) so it can be
indexed for retrieval.

## ⚠️ Confidentiality — read this

This repo holds **only public data** that anyone can see on palegis.us. That is deliberate.

**Never commit** to this repo: the SharePoint *Legislation Tracker*, caucus agendas, chairman's
reports, staff notes, whip counts, or the office's AI-agent prompts. Those are internal and live
elsewhere. The `.gitignore` and this notice are the guardrail; respect them even though the repo
is private.

## Auto-update

`scripts/update-corpus.js` polls Rep. Day's palegis feeds, detects newly circulated co-sponsorship
memos and newly introduced bills, fetches their text, writes new markdown files, and commits them.
It is run on a schedule (a Claude Code scheduled routine) so the corpus stays current with no
manual work. See `scripts/update-corpus.js` for details.

Feeds used:
- Memo RSS: `https://www.palegis.us/house/rss/legislation/memos?sessionYear=2025&memberId=1190`
- Sponsored bills: `https://www.palegis.us/house/members/bio/1190/representative-gary-day`

_Last manual seed: 2026-06-23 (7 prime-sponsored CSMs, 2025–26 session)._
