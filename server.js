const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

const TARGET_URL = "https://d31beekkopsyst.cloudfront.net/beintv/tracks-v1a1/mono.m3u8";
const DELAY_MS = 30000; // Tam 30 saniye gecikme

// RAM'de segmentleri saklayacağımız alanlar
let segmentCache = new Map(); // segmentAdi -> { buffer, duration }
let segmentQueue = [];       // [{ name, timeAdded }]
let mediaSequenceBase = 1000;
let lastSeenSegments = new Set();

// 1. Ana yayını sürekli tarayıp yeni video parçalarını RAM'e indiren motor
function pollMasterStream() {
    const lib = TARGET_URL.startsWith('https') ? https : http;
    lib.get(TARGET_URL, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.google.com/"
        }
    }, (res) => {
        if (res.statusCode !== 200) return;
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            if (!data.includes('#EXTM3U')) return;

            const baseUrl = TARGET_URL.substring(0, TARGET_URL.lastIndexOf('/') + 1);
            const lines = data.split('\n');
            let currentDuration = 6.0;

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].trim();
                if (line.startsWith('#EXTINF:')) {
                    let parts = line.split(':');
                    if (parts[1]) {
                        currentDuration = parseFloat(parts[1]) || 6.0;
                    }
                } else if (line && !line.startsWith('#')) {
                    let segUrl = line.startsWith('http') ? line : baseUrl + line;
                    let segName = line.substring(line.lastIndexOf('/') + 1).split('?')[0];

                    if (!lastSeenSegments.has(segName)) {
                        lastSeenSegments.add(segName);
                        downloadAndCacheSegment(segUrl, segName, currentDuration);
                    }
                }
            }

            // 90 saniyeden eski segmentleri RAM'den temizle (Bellek şişmesini önler)
            const now = Date.now();
            segmentQueue = segmentQueue.filter(item => {
                if ((now - item.timeAdded) > 90000) {
                    segmentCache.delete(item.name);
                    lastSeenSegments.delete(item.name);
                    return false;
                }
                return true;
            });
        });
    }).on('error', (err) => {
        console.error("Poll hatası:", err.message);
    });
}

function downloadAndCacheSegment(segUrl, segName, duration) {
    const lib = segUrl.startsWith('https') ? https : http;
    lib.get(segUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.google.com/"
        }
    }, (res) => {
        if (res.statusCode !== 200) return;
        let chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const timeAdded = Date.now();
            segmentCache.set(segName, { buffer, duration });
            segmentQueue.push({ name: segName, timeAdded });
        });
    }).on('error', () => {});
}

// Sunucu başlar başlamaz arka planda buffer motorunu çalıştırıyoruz
pollMasterStream();
setInterval(pollMasterStream, 2000);

// 2. ExoPlayer'ın istek atacağı /bein.m3u8 endpoint'i (Tam 30 saniye geriden gelen liste üretir)
app.get('/bein.m3u8', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    const now = Date.now();
    // Tam 30 saniye (DELAY_MS) önce RAM'e girmiş olan segmentleri filtreliyoruz
    const delayedSegments = segmentQueue.filter(item => (now - item.timeAdded) >= DELAY_MS);

    if (delayedSegments.length < 3) {
        return res.status(503).send("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:6.0,\n/bein.m3u8");
    }

    // Son 6 segmenti alarak pürüzsüz bir HLS döngüsü oluşturuyoruz
    const windowSize = 6;
    const activeSegments = delayedSegments.slice(-windowSize);

    let m3u8Content = `#EXTM3U\n`;
    m3u8Content += `#EXT-X-VERSION:3\n`;
    m3u8Content += `#EXT-X-TARGETDURATION:6\n`;
    m3u8Content += `#EXT-X-MEDIA-SEQUENCE:${mediaSequenceBase + segmentQueue.indexOf(activeSegments[0])}\n`;

    for (let seg of activeSegments) {
        let cached = segmentCache.get(seg.name);
        let dur = cached ? cached.duration : 6.0;
        m3u8Content += `#EXTINF:${dur.toFixed(3)},\n`;
        m3u8Content += `/segment/${seg.name}\n`;
    }

    res.send(m3u8Content);
});

// 3. RAM'deki video parçalarını (segmentleri) sunan endpoint
app.get('/segment/:name', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'video/mp2t');

    const segName = req.params.name;
    const segment = segmentCache.get(segName);

    if (segment) {
        res.send(segment.buffer);
    } else {
        res.status(404).send("Segment RAM'de bulunamadı");
    }
});

app.listen(PORT, () => {
    console.log(`Sentetik HLS Buffer Proxy ${PORT} portunda çalışıyor...`);
});
