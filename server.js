const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

// GERÇEK HLS LİNKİN
const TARGET_URL = "https://d31beekkopsyst.cloudfront.net/beintv/tracks-v1a1/mono.m3u8";
const DELAY_MS = 30000; // Tam 30 saniye arka plan buffer'ı

// RAM'de segmentleri ve playlist geçmişini tutacağımız hafıza alanları
let segmentCache = new Map(); // segmentAdi -> { buffer, timeAdded }
let playlistHistory = [];    // { text, time }

// 1. Ana yayından m3u8 listesini ve video segmentlerini arka planda sürekli çeken motor
function pollStream() {
    const lib = TARGET_URL.startsWith('https') ? https : http;
    lib.get(TARGET_URL, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.google.com/"
        }
    }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            if (res.statusCode === 200 && data.includes('#EXTM3U')) {
                const now = Date.now();
                playlistHistory.push({ text: data, time: now });

                // Eski playlist geçmişini temizle (90 saniyeden eski olanlar çöpe)
                playlistHistory = playlistHistory.filter(item => (now - item.time) < 90000);

                // Playlist içindeki her bir video parçasını (.ts/.m4s) yakalayıp hemen RAM'e indiriyoruz
                const baseUrl = TARGET_URL.substring(0, TARGET_URL.lastIndexOf('/') + 1);
                const lines = data.split('\n');

                for (let line of lines) {
                    line = line.trim();
                    if (line && !line.startsWith('#')) {
                        let segUrl = line.startsWith('http') ? line : baseUrl + line;
                        let segName = line.substring(line.lastIndexOf('/') + 1);
                        downloadSegment(segUrl, segName);
                    }
                }

                // RAM şişmesin diye 60 saniyeden eski segmentleri hafızadan siliyoruz
                for (let [name, seg] of segmentCache.entries()) {
                    if ((now - seg.timeAdded) > 60000) {
                        segmentCache.delete(name);
                    }
                }
            }
        });
    }).on('error', (err) => {
        console.error("Akış çekme hatası:", err.message);
    });
}

// Segmentleri RAM'e indiren yardımcı fonksiyon
function downloadSegment(segmentUrl, segmentName) {
    if (segmentCache.has(segmentName)) return; // Zaten indiyse tekrar indirme

    const lib = segmentUrl.startsWith('https') ? https : http;
    lib.get(segmentUrl, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.google.com/"
        }
    }, (res) => {
        if (res.statusCode !== 200) return;
        let chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
            segmentCache.set(segmentName, {
                buffer: Buffer.concat(chunks),
                timeAdded: Date.now()
            });
        });
    }).on('error', () => {});
}

// Sunucu başlar başlamaz arka planda buffer motorunu çalıştırıyoruz
pollStream();
setInterval(pollStream, 2000); // Her 2 saniyede bir yeni segmentleri topla

// 2. Gecikmeli M3U8 Endpoint'i (İstemciye 30 saniye gerideki listeyi sunar)
app.get('/bein.m3u8', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (playlistHistory.length === 0) {
        return res.status(503).send("#EXTM3U\n# Sunucu ilk buffer'ı topluyor, lütfen 10 saniye bekleyin...");
    }

    // Hedef: Şu andan tam 30 saniye öncesi
    const targetTime = Date.now() - DELAY_MS;
    
    let bestMatch = playlistHistory[0];
    let minDiff = Math.abs(bestMatch.time - targetTime);

    for (let i = 1; i < playlistHistory.length; i++) {
        const diff = Math.abs(playlistHistory[i].time - targetTime);
        if (diff < minDiff) {
            minDiff = diff;
            bestMatch = playlistHistory[i];
        }
    }

    // Listemizi düzenleyip segmentleri kendi sunucu route'umuza bağlıyoruz
    const lines = bestMatch.text.split('\n');
    const modifiedLines = lines.map(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
            let segName = line.substring(line.lastIndexOf('/') + 1);
            return `/segment/${segName}`; // RAM'deki cache'den servis edilecek
        }
        return line;
    });

    res.send(modifiedLines.join('\n'));
});

// 3. RAM'deki Video Parçalarını Servis Eden Endpoint
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
    console.log(`Pre-buffered HLS Proxy ${PORT} portunda aktif ve çalışıyor!`);
});
