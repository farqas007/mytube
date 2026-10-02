// Regenerate sitemap.xml from the live MyTube trending feed.
//
// Usage: npm run sitemap
//
// Safety contract: sitemap.xml is only ever replaced when the API call
// succeeds and yields at least one usable video. On any failure the script
// exits non-zero and leaves the existing sitemap.xml completely untouched.

import { writeFile, rename, unlink } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

export const ORIGIN = "https://mytube.farqas007.workers.dev";
const TRENDING_API = `${ORIGIN}/api/trending?max=50`;
const REQUEST_TIMEOUT_MS = 30000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
// Cloudflare serves the static frontend from `public/` (see the `assets.directory`
// binding in wrangler.jsonc), so the ONLY sitemap the site ever serves is
// public/sitemap.xml — which is also what robots.txt advertises. The output path
// must therefore point inside public/; writing to the repository root produces a
// file nothing serves and that nothing deploys.
const sitemapPath = path.join(repoRoot, "public", "sitemap.xml");
const tempPath = sitemapPath + ".tmp";

// Exported so the test suite can assert the resolved output path without ever
// touching the network or the working tree.
export function resolveSitemapPath() {
  return sitemapPath;
}

const MAX_VIDEOS = 50;


function fail(message, error){
    console.error("generate-sitemap: " + message);
    if(error){
        console.error(String(error && error.stack ? error.stack : error));
    }
    process.exit(1);
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


async function fetchTrending(){
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try{
        const res = await fetch(TRENDING_API, {
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


export function buildSitemap(urls, lastmod){
    const entries = [
        {
            loc: `${ORIGIN}/`,
            priority: "1.0"
        }
    ].concat(urls.map(loc => ({ loc, priority: "0.7" })));

    const lines = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`
    ];

    for(const entry of entries){
        lines.push(`  <url>`);
        lines.push(`    <loc>${escapeXml(entry.loc)}</loc>`);
        lines.push(`    <lastmod>${lastmod}</lastmod>`);
        lines.push(`    <changefreq>daily</changefreq>`);
        lines.push(`    <priority>${entry.priority}</priority>`);
        lines.push(`  </url>`);
    }

    lines.push(`</urlset>`);
    return lines.join("\n") + "\n";
}


async function main(){
    let payload;
    try{
        payload = await fetchTrending();
    }
    catch(error){
        return fail("could not fetch " + TRENDING_API + "; sitemap.xml left unchanged.", error);
    }

    if(!payload || typeof payload !== "object" || !Array.isArray(payload.videos)){
        return fail("unexpected API response shape (missing `videos` array); sitemap.xml left unchanged.");
    }

    const seen = new Set();
    const urls = [];

    for(const video of payload.videos){
        if(urls.length >= MAX_VIDEOS){
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
    }

    if(urls.length === 0){
        return fail("API returned no usable \"yt:\" video ids; sitemap.xml left unchanged.");
    }

    const lastmod = new Date().toISOString().slice(0, 10);
    const xml = buildSitemap(urls, lastmod);

    // Write to a temp file and rename, so a crash mid-write can never leave a
    // truncated sitemap.xml behind.
    try{
        await writeFile(tempPath, xml, "utf8");
        await rename(tempPath, sitemapPath);
    }
    catch(error){
        try{
            await unlink(tempPath);
        }
        catch{
            // temp file may not exist; nothing to clean up
        }
        return fail("could not write sitemap.xml; the previous file is left in place.", error);
    }

    console.log(`generate-sitemap: wrote public/sitemap.xml (1 homepage + ${urls.length} watch URLs, lastmod ${lastmod}).`);
}


// Only generate when invoked directly (`npm run sitemap`). Importing this module
// — as tests/testSitemap.js does — must never hit the network or write a file.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}