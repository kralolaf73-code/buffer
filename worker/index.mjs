const DEFAULT_LINKS_URL = "https://raw.githubusercontent.com/kralolaf73-code/buffer/main/streams/links.json";
const SOURCE_REFERER = "https://taraftarium.xyz/";
const SOURCE_ORIGIN = "https://taraftarium.xyz";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
const LINKS_CACHE_MS = 60_000;
const STALE_LINKS_MAX_MS = 6 * 60 * 60 * 1000;
const SIGNED_URL_TTL_SECONDS = 15 * 60;

let cachedLinks = null;
let cachedLinksSource = "";
let cachedLinksAt = 0;

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    ...extra,
  };
}

function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: corsHeaders({ "Content-Type": "text/plain; charset=utf-8", ...headers }),
  });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json; charset=utf-8" }),
  });
}

function isSafeExternalUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false;
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.includes(":") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}

async function loadLinks(env) {
  const source = env.LINKS_JSON_URL || DEFAULT_LINKS_URL;
  const now = Date.now();
  if (cachedLinks && cachedLinksSource === source && now - cachedLinksAt < LINKS_CACHE_MS) {
    return cachedLinks;
  }

  try {
    const response = await fetch(source, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: 60, cacheEverything: true },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`links.json returned HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data.streams)) throw new Error("links.json is missing its streams array");

    const streams = data.streams.filter((item) =>
      item &&
      typeof item.name === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(item.name) &&
      typeof item.url === "string" && isSafeExternalUrl(item.url)
    );
    if (streams.length === 0) throw new Error("links.json contains no usable stream URLs");

    cachedLinks = {
      updatedAt: data.updatedAt || null,
      count: streams.length,
      streams,
    };
    cachedLinksSource = source;
    cachedLinksAt = now;
    return cachedLinks;
  } catch (error) {
    if (cachedLinks && cachedLinksSource === source && now - cachedLinksAt < STALE_LINKS_MAX_MS) {
      return cachedLinks;
    }
    throw error;
  }
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function importHmacKey(secret, usages) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("PROXY_SECRET must be configured as a secret of at least 32 characters");
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

async function signTarget(target, expires, secret) {
  const key = await importHmacKey(secret, ["sign"]);
  const payload = new TextEncoder().encode(`${expires}\n${target}`);
  return base64Url(await crypto.subtle.sign("HMAC", key, payload));
}

async function verifyTarget(target, expires, signature, secret) {
  if (!/^\d+$/.test(String(expires)) || !/^[A-Za-z0-9_-]+$/.test(signature || "")) return false;
  const expiration = Number(expires);
  const now = Math.floor(Date.now() / 1000);
  if (expiration < now || expiration > now + SIGNED_URL_TTL_SECONDS + 60) return false;
  if (!isSafeExternalUrl(target)) return false;
  try {
    const key = await importHmacKey(secret, ["verify"]);
    const payload = new TextEncoder().encode(`${expiration}\n${target}`);
    return await crypto.subtle.verify("HMAC", key, fromBase64Url(signature), payload);
  } catch {
    return false;
  }
}

async function proxyUrl(target, origin, secret) {
  if (!isSafeExternalUrl(target)) throw new Error("The playlist contains a non-HTTPS or unsafe URL");
  const expires = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;
  const signature = await signTarget(target, expires, secret);
  const local = new URL("/proxy", origin);
  local.searchParams.set("url", target);
  local.searchParams.set("expires", String(expires));
  local.searchParams.set("sig", signature);
  return local.href;
}

async function rewriteManifest(manifest, baseUrl, origin, secret) {
  if (!manifest.trimStart().startsWith("#EXTM3U")) return null;
  const lines = manifest.split(/\r?\n/);
  const rewritten = await Promise.all(lines.map(async (line) => {
    if (!line.trim()) return line;
    if (line.trimStart().startsWith("#")) {
      const matches = [...line.matchAll(/URI=(["'])(.*?)\1/gi)];
      let output = line;
      for (const match of matches) {
        const target = new URL(match[2], baseUrl).href;
        const localUrl = await proxyUrl(target, origin, secret);
        output = output.replace(match[0], `URI=${match[1]}${localUrl}${match[1]}`);
      }
      return output;
    }
    const target = new URL(line.trim(), baseUrl).href;
    return proxyUrl(target, origin, secret);
  }));
  return `${rewritten.join("\n")}\n`;
}

async function handleStream(name, request, env) {
  const links = await loadLinks(env);
  const item = links.streams.find((stream) => stream.name === name);
  if (!item) return text("Unknown stream.", 404);
  if (!env.PROXY_SECRET) return json({ error: "Worker setup incomplete: configure PROXY_SECRET." }, 503);

  try {
    const upstream = await fetch(item.url, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: SOURCE_REFERER,
        Origin: SOURCE_ORIGIN,
        Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    if (!upstream.ok) return text(`Upstream playlist returned HTTP ${upstream.status}.`, 502);
    const manifest = await upstream.text();
    const rewritten = await rewriteManifest(manifest, upstream.url || item.url, new URL(request.url).origin, env.PROXY_SECRET);
    if (!rewritten) return text("Upstream did not return a valid HLS playlist.", 502);
    return text(rewritten, 200, { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" });
  } catch (error) {
    return text(`Could not load HLS playlist: ${error.message}`, 502);
  }
}

async function handleProxy(request, env) {
  const requestUrl = new URL(request.url);
  const target = requestUrl.searchParams.get("url");
  const expires = requestUrl.searchParams.get("expires");
  const signature = requestUrl.searchParams.get("sig");
  if (!target || !signature || !env.PROXY_SECRET) return text("Invalid or unsigned proxy request.", 403);
  if (!(await verifyTarget(target, expires, signature, env.PROXY_SECRET))) {
    return text("Proxy signature is invalid or expired.", 403);
  }

  try {
    const headers = {
      "User-Agent": USER_AGENT,
      Referer: SOURCE_REFERER,
      Origin: SOURCE_ORIGIN,
      Accept: "*/*",
    };
    const range = request.headers.get("Range");
    if (range) headers.Range = range;

    const upstream = await fetch(target, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!upstream.ok || !upstream.body) return text(`Upstream media returned HTTP ${upstream.status}.`, 502);

    const contentType = (upstream.headers.get("Content-Type") || "").toLowerCase();
    const isManifest = new URL(target).pathname.toLowerCase().includes(".m3u8") ||
      contentType.includes("mpegurl") || contentType.startsWith("text/html");

    if (isManifest) {
      const body = await upstream.text();
      const rewritten = await rewriteManifest(body, upstream.url || target, requestUrl.origin, env.PROXY_SECRET);
      if (!rewritten) return text("Upstream did not return a valid HLS playlist.", 502);
      return text(rewritten, 200, { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8" });
    }

    const headersOut = corsHeaders({ "Content-Type": "video/mp2t" });
    for (const name of ["Content-Length", "Content-Range", "Accept-Ranges"]) {
      const value = upstream.headers.get(name);
      if (value) headersOut[name] = value;
    }
    return new Response(upstream.body, { status: upstream.status, headers: headersOut });
  } catch (error) {
    return text(`Could not proxy media: ${error.message}`, 502);
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
    if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed.", 405);

    try {
      if (url.pathname === "/healthz") {
        const links = await loadLinks(env);
        return json({ status: "ok", count: links.count, updatedAt: links.updatedAt });
      }
      if (url.pathname === "/api/links") {
        const links = await loadLinks(env);
        return json({
          updatedAt: links.updatedAt,
          count: links.count,
          streams: links.streams.map(({ name }) => ({
            name,
            url: new URL(`/stream/${encodeURIComponent(name)}.m3u8`, url.origin).href,
          })),
        });
      }
      if (url.pathname === "/proxy") return handleProxy(request, env);

      const match = /^\/stream\/([A-Za-z0-9_-]{1,64})\.m3u8$/.exec(url.pathname);
      if (match) return handleStream(match[1], request, env);

      if (url.pathname === "/" || url.pathname === "/index.html") {
        const links = await loadLinks(env);
        const rows = links.streams.map(({ name }) => {
          const href = `/stream/${encodeURIComponent(name)}.m3u8`;
          return `<li><code>${escapeHtml(name)}</code> <a href="${href}">M3U8 bağlantısını aç</a></li>`;
        }).join("\n");
        return text(`<!doctype html><html lang="tr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Yayın listeleri</title><body><h1>Yayın listeleri</h1><p>Güncelleme: ${escapeHtml(links.updatedAt || "bilinmiyor")}; ${links.count} kanal.</p><ul>${rows}</ul></body></html>`, 200, { "Content-Type": "text/html; charset=utf-8" });
      }
      return text("Not found.", 404);
    } catch (error) {
      return json({ error: error.message || "Unexpected worker error" }, 502);
    }
  },
};
