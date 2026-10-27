const express = require('express');
const http = require('http');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

// KENDİ PORTSUZ LİNKİNİ BURAYA YAPIŞTIR
const TARGET_URL = "https://d31beekkopsyst.cloudfront.net/beintv/tracks-v1a1/mono.m3u8"; 
const DELAY_MS = 30000; // 30 saniye buffer (İstersen 60000 yapıp 1 dakika da yapabilirsin)

app.get('/bein.m3u8', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'video/mp2t');

    const lib = TARGET_URL.startsWith('https') ? https : http;

    lib.get(TARGET_URL, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer": "https://www.google.com/"
        }
    }, (upstream) => {
        let bufferQueue = [];

        upstream.on('data', (chunk) => {
            const receiveTime = Date.now();
            bufferQueue.push({ chunk, receiveTime });
        });

        const interval = setInterval(() => {
            const now = Date.now();
            while (bufferQueue.length > 0 && (now - bufferQueue[0].receiveTime) >= DELAY_MS) {
                const item = bufferQueue.shift();
                res.write(item.chunk);
            }
        }, 100);

        req.on('close', () => {
            clearInterval(interval);
            upstream.destroy();
        });

    }).on('error', (err) => {
        res.status(500).send("Buffer Hatası: " + err.message);
    });
});

app.listen(PORT, () => {
    console.log(`Buffer proxy ${PORT} portunda çalışıyor...`);
});
