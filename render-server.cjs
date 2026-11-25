const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const LINKS_FILE = path.join(ROOT, "streams", "links.json");
const LINKS_URL = process.env.GITHUB_LINKS_URL ||
  "https://raw.githubusercontent.com/kralolaf73-code/buffer/main/streams/links.json";
const LINKS_CACHE_MS = 60_000;
const URL_TTL_MS = 15 * 60_000;
const UPSTREAM_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
  Referer: "https://taraftarium.xyz/",
  Origin: "https://taraftarium.xyz/",
};

let cachedLinks = null;
let lastLinksFetch = 0;
let linksPromise = null;
const issuedUrls = new Map();
const knownHosts = new Set();

function normalizeLinks(value) {
  if (!value || !Array.isArray(value.streams)) throw new Error("links.json içinde streams listesi yok.");
  const streams = value.streams.filter((item) => {
    if (!item || typeof item.name !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(item.name)) return false;
    try {
      const url = new URL(item.url);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }).map(({ name, url }) => ({ name, url }));
  if (streams.length === 0) throw new Error("links.json içinde geçerli HTTPS yayın adresi yok.");
  return {
    schemaVersion: value.schemaVersion || 1,
    updatedAt: value.updatedAt || null,
    workingDomain: value.workingDomain || null,
    count: streams.length,
    streams,
  };
}

function readLocalLinks() {
  try {
    return normalizeLinks(JSON.parse(fs.readFileSync(LINKS_FILE, "utf8")));
  } catch (error) {
    console.error("Yerel links.json okunamadı:", error.message);
    return null;
  }
}

function rememberHosts(payload) {
  for (const item of payload.streams) {
    try { knownHosts.add(new URL(item.url).hostname.toLowerCase()); } catch {}
  }
}

cachedLinks = readLocalLinks();
if (cachedLinks) rememberHosts(cachedLinks);

async function getLinks(force = false) {
  if (!force && cachedLinks && lastLinksFetch && Date.now() - lastLinksFetch < LINKS_CACHE_MS) {
    return cachedLinks;
  }
  if (linksPromise) return linksPromise;

  linksPromise = (async () => {
    try {
      const response = await fetch(LINKS_URL, {
        headers: { "User-Agent": UPSTREAM_HEADERS["User-Agent"], Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`GitHub links.json HTTP ${response.status}`);
      const payload = normalizeLinks(await response.json());
      cachedLinks = payload;
      rememberHosts(payload);
      lastLinksFetch = Date.now();
      return payload;
    } catch (error) {
      console.warn("Güncel GitHub links.json alınamadı; yerel kopya kullanılacak:", error.message);
      const local = readLocalLinks();
      if (local) {
        cachedLinks = local;
        rememberHosts(local);
      }
      lastLinksFetch = Date.now();
      return cachedLinks;
    }
  })();

  try {
    return await linksPromise;
  } finally {
    linksPromise = null;
  }
}

function findStream(payload, name) {
  return payload?.streams.find((item) => item.name === name) || null;
}

function recordUpstream(rawUrl, baseUrl) {
  let url;
  try { url = new URL(rawUrl, baseUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || (!knownHosts.has(host) && !host.endsWith(".cfd"))) return null;
  knownHosts.add(host);

  if (issuedUrls.size > 10_000) {
    const now = Date.now();
    for (const [key, expiry] of issuedUrls) if (expiry < now) issuedUrls.delete(key);
  }
  issuedUrls.set(url.href, Date.now() + URL_TTL_MS);
  return url.href;
}

function proxyPath(url) {
  return `/proxy?url=${encodeURIComponent(url)}`;
}

function rewriteManifest(text, baseUrl) {
  if (!text.trimStart().startsWith("#EXTM3U")) return null;
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (line.trimStart().startsWith("#")) {
      return line.replace(/URI=(["'])(.*?)\1/gi, (match, quote, rawUrl) => {
        const absolute = recordUpstream(rawUrl, baseUrl);
        return absolute ? `URI=${quote}${proxyPath(absolute)}${quote}` : match;
      });
    }
    const absolute = recordUpstream(line.trim(), baseUrl);
    return absolute ? proxyPath(absolute) : line;
  }).join("\n");
}

function corsAndNoCache(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, If-Range, Content-Type, Origin, Accept");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
}

app.disable("x-powered-by");
app.use((req, res, next) => {
  corsAndNoCache(res);
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (_req, res) => res.type("html").sendFile(path.join(ROOT, "preview.html")));

app.get("/healthz", async (_req, res) => {
  const payload = await getLinks();
  if (!payload) return res.status(503).json({ status: "error", message: "links.json henüz okunamıyor." });
  res.json({
    status: "ok",
    source: "GitHub links.json",
    count: payload.count,
    updatedAt: payload.updatedAt,
    lastCheckedAt: lastLinksFetch ? new Date(lastLinksFetch).toISOString() : null,
    proxy: "ready",
  });
});

app.get("/api/streams", async (_req, res) => {
  const payload = await getLinks();
  if (!payload) return res.status(503).json({ error: "GitHub links.json henüz kullanılamıyor." });
  const streams = payload.streams.map(({ name }) => ({
    name,
    href: `/streams/stream_${encodeURIComponent(name)}.m3u8`,
    playback: `/live/${encodeURIComponent(name)}.m3u8`,
  }));
  res.json({ updatedAt: payload.updatedAt, count: streams.length, streams });
});

app.get("/streams/:filename", async (req, res) => {
  const match = /^stream_([A-Za-z0-9_-]+)\.m3u8$/.exec(req.params.filename);
  const payload = await getLinks();
  if (!match || !findStream(payload, match[1])) return res.status(404).send("Liste bulunamadı.");
  res.type("application/vnd.apple.mpegurl").send(
    `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,FRAME-RATE=25\n/live/${match[1]}.m3u8\n`
  );
});

app.get("/live/:name.m3u8", async (req, res) => {
  const payload = await getLinks();
  const item = findStream(payload, req.params.name);
  if (!item) return res.status(404).send("Yayın listesi bulunamadı.");
  try {
    const upstream = await fetch(item.url, {
      headers: UPSTREAM_HEADERS,
      signal: AbortSignal.timeout(12_000),
    });
    if (!upstream.ok) return res.status(502).send(`Kaynak yayın HTTP ${upstream.status} döndürdü.`);
    const body = await upstream.text();
    const manifest = rewriteManifest(body, upstream.url || item.url);
    if (!manifest) return res.status(502).send("Kaynak geçerli bir HLS/M3U8 listesi döndürmedi.");
    res.type("application/vnd.apple.mpegurl").send(manifest);
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    res.status(502).send(timedOut ? "Kaynak zaman aşımına uğradı." : "Kaynak yayın alınamadı.");
  }
});

app.get("/proxy", async (req, res) => {
  const rawUrl = req.query.url;
  if (typeof rawUrl !== "string" || rawUrl.length > 4096) return res.status(400).send("Geçersiz kaynak adresi.");
  let url;
  try { url = new URL(rawUrl); } catch { return res.status(400).send("Geçersiz kaynak adresi."); }
  const expiry = issuedUrls.get(url.href);
  if (!expiry || expiry < Date.now() || !knownHosts.has(url.hostname.toLowerCase())) {
    issuedUrls.delete(url.href);
    return res.status(403).send("Bu kaynak adresi geçerli bir HLS listesinde bulunamadı.");
  }

  const headers = { ...UPSTREAM_HEADERS };
  if (req.headers.range) headers.Range = req.headers.range;
  if (req.headers["if-range"]) headers["If-Range"] = req.headers["if-range"];

  let upstream;
  try {
    upstream = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    return res.status(502).send(timedOut ? "Medya segmenti zaman aşımına uğradı." : "Medya segmenti alınamadı.");
  }
  if (!upstream.ok || !upstream.body) return res.status(502).send(`Kaynak segment HTTP ${upstream.status} döndürdü.`);

  const upstreamContentType = upstream.headers.get("content-type") || "";
  const contentType = upstreamContentType;
  const mightBePlaylist = url.pathname.toLowerCase().includes(".m3u8") || /mpegurl/i.test(contentType);
  if (mightBePlaylist) {
    let text;
    try { text = await upstream.text(); } catch { return res.status(502).send("Kaynak playlist okunamadı."); }
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) return res.status(502).send("Kaynak playlist beklenen boyuttan büyük.");
    const manifest = rewriteManifest(text, upstream.url || url.href);
    if (!manifest) return res.status(502).send("Geçersiz HLS playlist.");
    return res.type("application/vnd.apple.mpegurl").send(manifest);
  }

  res.status(upstream.status);
  const isTransportSegment = /\.(?:ts|m2ts|jpe?g)$/i.test(url.pathname);
  res.setHeader("Content-Type", isTransportSegment ? "video/mp2t" : (contentType || "application/octet-stream"));
  for (const header of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    if (!res.headersSent) res.status(502);
    else res.destroy(error);
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Render HLS proxy listening on ${PORT}; links source: GitHub.`);
  getLinks(true).catch((error) => console.error("Başlangıç links.json kontrolü başarısız:", error.message));
});
