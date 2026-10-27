const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
const PORT = process.env.PORT || 3000;

// GERÇEK HLS LİNKİN
const TARGET_URL = "https://d31beekkopsyst.cloudfront.net/beintv/tracks-v1a1/mono.m3u8";
const DELAY_MS = 30000; // Tam 30 saniye gecikme (30000 ms)

let playlistHistory = [];

// Arka planda her 3 saniyede bir ana m3u8 listesini çekip RAM'de tarihçesini tutuyoruz
function fetchPlaylist() {
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
                
                // Bellek şişmemesi için sadece son 60 saniyenin geçmişini tutuyoruz
                playlistHistory = playlistHistory.filter(item => (now - item.time) < 60000);
            }
        });
    }).on('error', (err) => {
        console.error("Playlist çekme hatası:", err.message);
    });
}

// İlk başlatma ve periyodik döngü
fetchPlaylist();
setInterval(fetchPlaylist, 3000);

app.get('/bein.m3u8', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (playlistHistory.length === 0) {
        return res.status(503).send("Yayın henüz tamponlanıyor, lütfen 10 saniye bekleyin...");
    }

    const targetTime = Date.now() - DELAY_MS;
    
    // Tam 30 saniye öncesine ait en yakın playlist kaydını seçiyoruz
    let bestMatch = playlistHistory[0];
    let minDiff = Math.abs(bestMatch.time - targetTime);

    for (let i = 1; i < playlistHistory.length; i++) {
        const diff = Math.abs(playlistHistory[i].time - targetTime);
        if (diff < minDiff) {
            minDiff = diff;
            bestMatch = playlistHistory[i];
        }
    }

    // Playlist içindeki göreceli segment linklerini CloudFront tabanlı tam adrese çeviriyoruz
    const baseUrl = TARGET_URL.substring(0, TARGET_URL.lastIndexOf('/') + 1);
    const lines = bestMatch.text.split('\n');
    const modifiedLines = lines.map(line => {
        line = line.trim();
        if (line && !line.startsWith('#')) {
            if (!line.startsWith('http')) {
                return baseUrl + line;
            }
        }
        return line;
    });

    res.send(modifiedLines.join('\n'));
});

app.listen(PORT, () => {
    console.log(`HLS Buffer Proxy ${PORT} portunda kusursuz çalışıyor...`);
});
