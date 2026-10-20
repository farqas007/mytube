// Regenerate sitemap.xml from the live MyTube trending feed.
//
// Usage: npm run sitemap
//
// Safety contract: the generated sitemap is only ever written when the whole
// pagination walk succeeds and yields at least one usable video, AND the
// existing public/sitemap.xml (when present) parses cleanly. On any failure the
// script exits non-zero and leaves the existing sitemap.xml completely
// untouched.
//
// Rather than replacing the old file, the new document is a MERGE: every watch
// URL already listed is preserved with its own <lastmod>, and newly collected
// URLs are appended with today's date. The homepage entry, the /watch?id=
// canonical encoding, XML escaping and the atomic temp-file + rename write are
// all unchanged.
//
// URL-cap semantics (MYTUBE_SITEMAP_MAX_URLS): the value is the TOTAL number of
// URLs the final document may contain, THE HOMEPAGE INCLUDED. It is clamped to
// 50,000 — the sitemap protocol ceiling — so a run configured at exactly 50,000
// produces at most 49,999 watch URLs plus the homepage, never 50,001. The cap
// is enforced twice: while collecting (one slot is reserved for the homepage)
// and again while merging (the deterministic FIFO trim).

import { existsSync } from "node:fs";
import { writeFile, rename, unlink, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const ORIGIN = "https://mytube.farqas007.workers.dev";
const TRENDING_API = `${ORIGIN}/api/trending?max=50`;
const REQUEST_TIMEOUT_MS = 30000;

// Hard ceiling enforced by the collection and merge steps. The sitemap protocol
// allows up to 50,000 URLs / 50 MB — counting every <url> element, homepage
// included — so the ceiling is applied to the TOTAL document and cannot be
// exceeded no matter what MYTUBE_SITEMAP_MAX_URLS is set to. The default sits
// far below it to keep the committed file small and crawls cheap.
export const DEFAULT_MAX_SITEMAP_URLS = 5000;
const SITEMAP_PROTOCOL_MAX_URLS = 50000;

// Upper bound on pagination pages per run, so a server that never clears
// nextPageToken cannot turn the generator into an unbounded crawl.
export const MAX_PAGINATION_PAGES = 100;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
// Cloudflare serves the static frontend from `public/` (see the `assets.directory`
// binding in wrangler.jsonc), so the ONLY sitemap the site ever serves is
// public/sitemap.xml — which is also what robots.txt advertises. The output path
// must therefore point inside public/; writing to the repository root produces a
// file nothing serves and that nothing deploys.
const sitemapPath = path.join(repoRoot, "public", "sitemap.xml");

// Exported so the test suite can assert the resolved output path without ever
// touching the network or the working tree.
export function resolveSitemapPath() {
  return sitemapPath;
}

function fail(message, error){
    console.error("generate-sitemap: " + message);
    if(error){
        console.error(String(error && error.stack ? error.stack : error));
    }
    process.exit(1);
}

// Resolve the configured URL budget: the maximum number of URLs the FINAL
// document may contain, the homepage included. Invalid or absent values fall
// back to the default; the final value is clamped to the 50,000-URL sitemap
// protocol ceiling so one bad env value cannot balloon the file.
export function resolveMaxSitemapUrls(raw){
    if(raw === undefined || raw === null){
        return DEFAULT_MAX_SITEMAP_URLS;
    }
    const value = String(raw).trim();
    if(!value){
        return DEFAULT_MAX_SITEMAP_URLS;
    }
    const n = Number(value);
    if(!Number.isFinite(n) || n <= 0){
        return DEFAULT_MAX_SITEMAP_URLS;
    }
    return Math.min(Math.floor(n), SITEMAP_PROTOCOL_MAX_URLS);
}

// MyTube is YouTube-only: every playable id is "yt:<sourceId>". Only those
// ids produce a resolvable /watch?id=... URL, so anything else is skipped.
//
// The `encodeURIComponent(trimmed)` call is the single encoding convention for a
// /watch?id=... URL across the whole repository. worker.js (setVideoCanonical)
// and public/watch.js (setVideoPageMeta) must produce the exact same string, or
// the sitemap and the page's own canonical disagree.
export function watchUrl(id){
    if(typeof id !== "string"){
        return "";
    }
    const trimmed = id.trim();
    if(!trimmed.startsWith("yt:")){
        return "";
    }
    const sourceId = trimmed.slice(3).trim();
    if(!sourceId){
        return "";
    }
    return `${ORIGIN}/watch?id=${encodeURIComponent(trimmed)}`;
}


function escapeXml(value){
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function unescapeXml(value){
    return String(value)
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}


// Fetch ONE /api/trending page. `pageToken` (when given) is appended to the
// endpoint's query string as the opaque continuation cursor.
async function fetchTrendingPage(endpoint, pageToken, fetchImpl){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try{
        const url = new URL(endpoint);
        if(pageToken){
            url.searchParams.set("pageToken", pageToken);
        }
        const res = await fetchImpl(url.href, {
            headers: { "accept": "application/json" },
            signal: controller.signal
        });
        if(!res.ok){
            throw new Error(`API responded ${res.status} ${res.statusText}`);
        }
        return await res.json();
    }
    finally{
        clearTimeout(timer);
    }
}


// Walk the cursor of the /api/trending feed and collect every unique usable
// watch URL up to the configured budget. `maxUrls` is a TOTAL document budget
// (the live sitemap always opens with the homepage), so a single run returns at
// most `maxUrls - 1` watch URLs — one slot stays reserved for the homepage.
// Pages after the first are served from the warm feed pool, so they cost no
// upstream quota.
//
// Fail-safe by design: a non-OK response, a missing `videos` array, a page that
// advertises a next token but contributes nothing new, or a run that never
// reaches the end of the feed all throw instead of returning a partial set.
export async function collectTrendingUrls(options = {}){
    const endpoint = options.endpoint || TRENDING_API;
    const fetchImpl = options.fetchImpl || fetch;
    const maxUrls = resolveMaxSitemapUrls(options.maxUrls);
    const maxWatchUrls = Math.max(0, maxUrls - 1);
    const maxPages = Math.max(1, Number(options.maxPages) || MAX_PAGINATION_PAGES);

    const seen = new Set();
    const urls = [];
    let pageToken = "";
    let pages = 0;

    while(true){
        if(pages >= maxPages){
            throw new Error(`pagination exceeded ${maxPages} pages without reaching the feed end; aborting to stay safe`);
        }
        pages++;

        const payload = await fetchTrendingPage(endpoint, pageToken, fetchImpl);

        if(!payload || typeof payload !== "object" || !Array.isArray(payload.videos)){
            throw new Error("unexpected API response shape (missing `videos` array)");
        }

        let added = 0;

        for(const video of payload.videos){
            if(urls.length >= maxWatchUrls){
                break;
            }
            if(!video || typeof video !== "object"){
                continue;
            }
            const url = watchUrl(video.id);
            if(!url || seen.has(url)){
                continue;
            }
            seen.add(url);
            urls.push(url);
            added++;
        }

        if(urls.length >= maxWatchUrls){
            break;
        }

        const next = payload.nextPageToken;

        if(added === 0 && next){
            throw new Error("pagination stopped making progress while more pages were advertised; aborting to stay safe");
        }
        if(!next){
            break;
        }
        pageToken = next;
    }

    return urls;
}


// Parse a sitemap document back into [{ loc, lastmod }] entries, in file order.
// Returns [] for an absent/empty string so a first run or an empty file starts
// clean.
//
// Anything that is not a COMPLETE, well-formed urlset throws — the caller must
// treat a malformed existing sitemap as a failure and leave the file alone:
//
//   * not a sitemap at all (no <?xml?> or <urlset> opening)
//   * an incomplete document: the opening <urlset> must be closed by exactly
//     one </urlset> (a file truncated mid-write or mid-crawl must not smuggle
//     its intact <url> blocks past the parser and get silently rewritten)
//   * a <url> block that is never closed (same truncation hazard)
//   * a <url> block that opens inside the urlset but closes across the
//     </urlset> boundary, or trailing content after the closing </urlset>
//     (both would otherwise be scooped up by the block search and merged into
//     the regenerated file)
//   * unexpected markup before <urlset>
//   * no <url> entries at all, or a <url> without a <loc>
//
// The checks are structural, not just global tag counts: every <url> block is
// matched inside the span delimited by the single urlset opener and closer, so
// tags outside that span — or a block crossing it — cannot contribute entries.
export function parseSitemap(xml){
    if(typeof xml !== "string" || !xml.replace(/^\uFEFF/, "").trim()){
        return [];
    }
    const text = xml.replace(/^\uFEFF/, "").trim();

    if(!text.startsWith("<?xml") && !text.startsWith("<urlset")){
        throw new Error("existing sitemap is not a sitemap document");
    }

    // The document must be complete: exactly one <urlset> opener and exactly one
    // closing </urlset>. A truncated file passes the <url> block regex below, so
    // its completeness has to be proven here or it would be accepted and then
    // overwritten — the exact failure this parser exists to prevent.
    const urlsetOpens = [...text.matchAll(/<urlset\b/gi)].length;
    const urlsetCloses = [...text.matchAll(/<\/urlset>/gi)].length;
    if(urlsetOpens !== 1 || urlsetCloses !== 1){
        throw new Error("existing sitemap is incomplete (expected one <urlset> and one </urlset>)");
    }

    // Scope everything below to the span between that single opener and closer.
    // Matching the whole text would let markup outside the urlset — or a block
    // crossing its boundary — contribute entries that then get merged into the
    // regenerated file. Locating the tags first and searching only the inner
    // span closes both holes structurally, not by counting alone.
    const opener = /<urlset\b/gi.exec(text);
    const closer = /<\/urlset>/gi.exec(text);
    const openerTag = /^<urlset\b[^>]*>/i.exec(text.slice(opener.index));
    if(!openerTag){
        throw new Error("existing sitemap is incomplete (unclosed <urlset> opening tag)");
    }

    const head = text.slice(0, opener.index);
    const docBody = text.slice(opener.index + openerTag[0].length, closer.index);
    const tail = text.slice(closer.index + closer[0].length);

    if(head.trim() && !/^<\?xml\b[^>]*\?>\s*$/.test(head)){
        throw new Error("existing sitemap has unexpected content before <urlset>");
    }

    // Every <url> opener inside the span must be matched by a </url> closer. An
    // unclosed <url> block is truncation, and a block that opens inside the
    // urlset but closes after </urlset> leaves its closer in the tail, so it is
    // unbalanced here too — its partial entry must not be dropped silently.
    const urlOpens = [...docBody.matchAll(/<url\b[^>]*>/gi)].length;
    const urlCloses = [...docBody.matchAll(/<\/url>/gi)].length;
    if(urlOpens !== urlCloses){
        throw new Error("existing sitemap is incomplete (unclosed <url> block)");
    }

    const blocks = [...docBody.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)];

    if(!blocks.length){
        throw new Error("existing sitemap contains no <url> entries");
    }

    if(tail.trim()){
        throw new Error("existing sitemap has trailing content after </urlset>");
    }

    const entries = [];

    for(const match of blocks){
        const locMatch = /<loc\b[^>]*>([\s\S]*?)<\/loc>/i.exec(match[1]);

        if(!locMatch){
            throw new Error("existing sitemap has a <url> without <loc>");
        }

        const lastmodMatch = /<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i.exec(match[1]);

        entries.push({
            loc: unescapeXml(locMatch[1]).trim(),
            lastmod: lastmodMatch ? unescapeXml(lastmodMatch[1]).trim() : ""
        });
    }

    return entries;
}


// Merge preserved and freshly collected watch URLs into one ordered entry list.
//
//   * homepage stays first, keeping its existing <lastmod> when present
//   * existing watch URLs keep their original <lastmod> and their original order
//   * newly collected URLs are appended with today's date
//   * duplicates (by exact encoded loc) are collapsed
//   * anything that is not a MyTube homepage or /watch?id= URL is dropped
//   * `maxUrls` is the TOTAL document budget (the homepage IS the first slot,
//     never an extra), so when the merged watch count exceeds `maxUrls - 1` the
//     OLDEST watch URLs are dropped (deterministic FIFO trim). The merged
//     document can therefore never exceed 50,000 <url> entries even when the
//     budget is configured at the maximum.
export function mergeSitemapEntries(existingEntries, freshUrls, options = {}){
    const maxUrls = resolveMaxSitemapUrls(options.maxUrls);
    const maxWatchUrls = Math.max(0, maxUrls - 1);
    const today = typeof options.today === "string" && options.today
        ? options.today
        : new Date().toISOString().slice(0, 10);

    const homepageLoc = `${ORIGIN}/`;
    const watchPrefix = `${ORIGIN}/watch?id=`;

    const known = new Map();

    for(const entry of Array.isArray(existingEntries) ? existingEntries : []){
        if(!entry || typeof entry.loc !== "string"){
            continue;
        }
        const loc = entry.loc.trim();
        if(!loc){
            continue;
        }
        known.set(loc, {
            loc,
            lastmod: typeof entry.lastmod === "string" && entry.lastmod ? entry.lastmod : today
        });
    }

    const homepage = known.get(homepageLoc) || { loc: homepageLoc, lastmod: today };

    const watches = [];
    const seen = new Set();

    for(const loc of known.keys()){
        if(loc === homepageLoc || !loc.startsWith(watchPrefix) || seen.has(loc)){
            continue;
        }
        seen.add(loc);
        watches.push(known.get(loc));
    }

    for(const loc of Array.isArray(freshUrls) ? freshUrls : []){
        if(!loc || !loc.startsWith(watchPrefix) || seen.has(loc)){
            continue;
        }
        seen.add(loc);
        watches.push({ loc, lastmod: today });
    }

    if(watches.length > maxWatchUrls){
        watches.splice(0, watches.length - maxWatchUrls);
    }

    return [homepage, ...watches];
}


// Render the full document. `entries[0]` is the homepage (priority 1.0); every
// later entry is a watch URL (priority 0.7). Each entry carries its own loc and
// lastmod, so existing entries keep their original date while new ones get
// today's — lastmod reflects the page's actual last change, not generation time.
export function buildSitemap(entries){
    const list = Array.isArray(entries) ? entries : [];
    const lines = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
    ];

    for(let i = 0; i < list.length; i++){
        const entry = list[i] || {};
        const loc = typeof entry.loc === "string" ? entry.loc : "";
        const lastmod = typeof entry.lastmod === "string" ? entry.lastmod : "";
        const priority = i === 0 ? "1.0" : "0.7";

        lines.push(`  <url>`);
        lines.push(`    <loc>${escapeXml(loc)}</loc>`);
        lines.push(`    <lastmod>${escapeXml(lastmod)}</lastmod>`);
        lines.push(`    <changefreq>daily</changefreq>`);
        lines.push(`    <priority>${priority}</priority>`);
        lines.push(`  </url>`);
    }

    lines.push(`</urlset>`);
    return lines.join("\n") + "\n";
}


// The full generation pipeline, refactored to be testable without the network
// or the working tree: every external input (fetch impl, output path, today's
// date, max URL count) is injectable. Throws instead of process.exit, so tests
// can assert failure modes directly. On any failure nothing is written and any
// partial temp file is removed.
export async function generateSitemap(options = {}){
    const fetchImpl = options.fetchImpl || fetch;
    const maxUrls = resolveMaxSitemapUrls(options.maxUrls);
    const today = typeof options.today === "string" && options.today
        ? options.today
        : new Date().toISOString().slice(0, 10);
    const outputPath = options.outputPath || sitemapPath;
    const tempOutputPath = outputPath + ".tmp";

    const freshUrls = await collectTrendingUrls({
        endpoint: TRENDING_API,
        fetchImpl,
        maxUrls
    });

    if(freshUrls.length === 0){
        throw new Error('API returned no usable "yt:" video ids');
    }

    let existingEntries = [];

    if(existsSync(outputPath)){
        const xml = await readFile(outputPath, "utf8");
        existingEntries = parseSitemap(xml);
    }

    const entries = mergeSitemapEntries(existingEntries, freshUrls, { maxUrls, today });
    const xml = buildSitemap(entries);

    // Write to a temp file and rename, so a crash mid-write can never leave a
    // truncated sitemap.xml behind.
    try{
        await writeFile(tempOutputPath, xml, "utf8");
        await rename(tempOutputPath, outputPath);
    }
    catch(error){
        try{
            await unlink(tempOutputPath);
        }
        catch{
            // temp file may not exist; nothing to clean up
        }
        throw error;
    }

    return { entries, xml, wrote: entries.length };
}


// Only generate when invoked directly (`npm run sitemap`). Importing this module
// — as tests/testSitemap.js does — must never hit the network or write a file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    generateSitemap()
        .then(({ entries }) => {
            const watchCount = Math.max(0, entries.length - 1);
            console.log(`generate-sitemap: wrote public/sitemap.xml (1 homepage + ${watchCount} watch URLs).`);
        })
        .catch(error => fail("sitemap generation failed; sitemap.xml left unchanged.", error));
}
