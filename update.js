import fs from "fs";

const REDIRECT_URL = "https://trgoalsgiris.xyz";
const BASE_PATTERN = "https://taraftarium1087.xyz/";
const CONFIG_PAGE_PATH = "/channel.html?id=trgoals";
const MAX_ATTEMPTS = 15;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"
const REFERER = "https://taraftarium.xyz/"
const OUTPUT_DIR = "streams";
const SUFFIX = "mono.m3u8"

const healthReport = {
    timestamp: Date.now(),
    success: false,
    workingDomain: null,
    baseUrl: null,
    streams: [],
    error: null
};

const STREAM_SUFFIXES = [
    { name: "patron", path: `patron/${SUFFIX}` },
    { name: "zirve", path: `zirve/mono/${SUFFIX}` },
    { name: "yayin1", path: `yayin1/${SUFFIX}` },
    { name: "inat", path: `inat/${SUFFIX}` },
    { name: "b2", path: `b2/${SUFFIX}` },
    { name: "b3", path: `b3/${SUFFIX}` },
    { name: "b4", path: `b4/${SUFFIX}` },
    { name: "b5", path: `b5/${SUFFIX}` },
    { name: "bm1", path: `bm1/${SUFFIX}` },
    { name: "bm2", path: `bm2/${SUFFIX}` },
    { name: "ss", path: `ss/${SUFFIX}` },
    { name: "ss2", path: `ss2/${SUFFIX}` },
    { name: "t1", path: `t1/${SUFFIX}` },
    { name: "t2", path: `t2/${SUFFIX}` },
    { name: "t3", path: `t3/${SUFFIX}` },
    { name: "t4", path: `t4/${SUFFIX}` },
    { name: "smarts", path: `smarts/${SUFFIX}` },
    { name: "sms2", path: `sms2/${SUFFIX}` },
    { name: "trtspor", path: `trtspor/${SUFFIX}` },
    { name: "trtspor2", path: `trtspor2/${SUFFIX}` },
    { name: "trt1", path: `trt1/${SUFFIX}` },
    { name: "as", path: `as/${SUFFIX}` },
    { name: "atv", path: `atv/${SUFFIX}` },
    { name: "tv8", path: `tv8/${SUFFIX}` },
    { name: "tv85", path: `tv85/${SUFFIX}` },
    { name: "f1", path: `f1/${SUFFIX}` },
    { name: "nbatv", path: `nbatv/${SUFFIX}` },
    { name: "ex1", path: `ex1/${SUFFIX}` },
    { name: "ex2", path: `ex2/${SUFFIX}` },
    { name: "ex3", path: `ex3/${SUFFIX}` },
    { name: "ex4", path: `ex4/${SUFFIX}` },
    { name: "ex5", path: `ex5/${SUFFIX}` },
    { name: "ex6", path: `ex6/${SUFFIX}` },
    { name: "ex7", path: `ex7/${SUFFIX}` },
    { name: "ex8", path: `ex8/${SUFFIX}` },
    { name: "eu1", path: `eu1/${SUFFIX}` },
    { name: "eu2", path: `eu2/${SUFFIX}` }
];

const CONFIG_REGEX = /CONFIG\s*=\s*\{[^}]*baseUrl\s*:\s*['"]([^'"]+)['"]/i;

const M3U8_HEADER = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=5500000,RESOLUTION=1920x1080,FRAME-RATE=25`;

async function fetchWithTimeout(url, timeout = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    return fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
            "User-Agent": USER_AGENT
        }
    })
        .then(res => {
            clearTimeout(id);
            if (!res.ok) return null;
            return res.text();
        })
        .catch(() => null);
}

function loadLastDomain() {
    if (!fs.existsSync("domains.json")) return null;
    const data = JSON.parse(fs.readFileSync("domains.json"));
    return data.lastWorking || null;
}

function saveLastDomain(domain) {
    fs.writeFileSync(
        "domains.json",
        JSON.stringify({ lastWorking: domain }, null, 2)
    );
}

async function extractButtonUrl(url) {
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": USER_AGENT
            }
        });

        if (!res || !res.ok) return null;

        const html = await res.text();

        // Find all anchors
        const matches = [
            ...html.matchAll(
                /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis
            )
        ];

        // Look for "canlı maç giriş" style text
        const target = matches.find(m => {
            const text = m[2]
                .replace(/<[^>]+>/g, "")
                .trim()
                .toLowerCase();

            return (
                text.includes("canlı") &&
                (
                    text.includes("giriş") ||
                    text.includes("girişi")
                )
            );
        });

        if (!target) return null;

        const extracted = new URL(target[1], url).href;

        console.log("Extracted button URL:", extracted);

        return extracted;

    } catch (err) {
        console.log("extractButtonUrl error:", err.message);
        return null;
    }
}

async function resolveRedirectChain(startUrl, maxDepth = 5) {
    const extracted = await extractButtonUrl(startUrl);
    let currentUrl = extracted || startUrl;

    if (extracted) {
        console.log("Using extracted URL instead of startUrl");
    }

    for (let i = 0; i < maxDepth; i++) {
        console.log("Resolving:", currentUrl);

        const res = await fetch(currentUrl, {
            redirect: "follow",
            headers: { "User-Agent": USER_AGENT }
        }).catch(() => null);

        if (!res || !res.ok) return null;

        let finalUrl = res.url;
        const text = await res.text();

        // 1 JS redirect
        const jsMatch = text.match(/location\.replace\(["']([^"']+)["']\)/i)
            || text.match(/window\.location\s*=\s*["']([^"']+)["']/i);

        if (jsMatch) {
            currentUrl = new URL(jsMatch[1], currentUrl).href;
            continue;
        }

        // 2 Meta refresh
        const metaMatch = text.match(
            /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"']+)["']/i
        );

        if (metaMatch) {
            currentUrl = new URL(metaMatch[1], currentUrl).href;
            continue;
        }

        return new URL(finalUrl).origin;
    }

    return null;
}

async function findWorkingDomain() {
    const candidates = [];

    const lastKnown = loadLastDomain();
    if (lastKnown) candidates.push(lastKnown);

    candidates.push(REDIRECT_URL);

    const match = REDIRECT_URL.match(/(\d+)/);
    const startNumber = match ? parseInt(match[1]) : 1000;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const guess = BASE_PATTERN.replace("{num}", startNumber + i);
        candidates.push(guess);
    }

    for (const domain of candidates) {
        console.log("Testing domain:", domain);
        const resolved = await resolveRedirectChain(domain);
        if (resolved) {
            console.log("Resolved final domain:", resolved);
            return resolved;
        }
    }

    return null;
}

async function extractBaseUrlFromPage(domain) {
    const fullUrl = domain + CONFIG_PAGE_PATH;

    console.log("Visiting config page:", fullUrl);

    const html = await fetchWithTimeout(fullUrl);
    if (!html) return null;

    const match = html.match(CONFIG_REGEX);
    return match ? match[1] : null;
}

async function validateStream(url) {
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: {
                "User-Agent": USER_AGENT,
                "Referer": REFERER,
                "Origin": REFERER
            }
        });

        if (!res.ok) {
            console.log("Status:", res.status);
            return false;
        }

        const text = await res.text();

        // Check if it looks like real m3u8
        if (text.includes("#EXTM3U")) {
            return true;
        }

        return false;

    } catch (err) {
        console.log("Error validating:", err.message);
        return false;
    }
}

async function generateStreams(baseUrl) {
    let success = 0;

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    for (const file of fs.readdirSync(OUTPUT_DIR)) {
        if (file.endsWith(".m3u8")) {
            fs.unlinkSync(`${OUTPUT_DIR}/${file}`);
        }
    }

    for (const stream of STREAM_SUFFIXES) {
        const streamUrl = baseUrl + stream.path;

        const streamStatus = {
            name: stream.name,
            url: streamUrl,
            valid: false,
            error: null
        };

    //    console.log("Validating stream:", streamUrl);

        try {
        //    const valid = await validateStream(streamUrl);

        //    if (valid) {
                streamStatus.valid = true;
                success++;

                const filename = `${OUTPUT_DIR}/stream_${stream.name}.m3u8`;

                const content = `${M3U8_HEADER}
${streamUrl}
`;

                fs.writeFileSync(filename, content);

           /* } else {
                streamStatus.error = "Validation failed";
            }*/

        } catch (err) {
            streamStatus.error = err.message;
        }

        healthReport.streams.push(streamStatus);
    }

    return success;
}

(async () => {
    try {
        const domain = await findWorkingDomain();
        healthReport.workingDomain = domain;
        if (!domain) throw new Error("No working domain found");

        const baseUrl = await extractBaseUrlFromPage(domain);
        healthReport.baseUrl = baseUrl;
        if (!baseUrl) throw new Error("Could not extract baseUrl");

        console.log("Extracted baseUrl:", baseUrl);

        const count = await generateStreams(baseUrl);
        if (count === 0) throw new Error("No valid streams generated");

        saveLastDomain(domain);

        healthReport.success = healthReport.streams.some(s => s.valid);

        fs.writeFileSync(
            "health.json",
            JSON.stringify(healthReport, null, 2)
        );

        console.log("Done. Streams generated:", count);
    } catch (err) {
        healthReport.error = err.message;
    }
})();
