const express = require('express');
const http = require('http');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

// CANLI YAYIN LİNKİNİ BURAYA YAPIŞTIR
const TARGET_URL = "https://d31beekkopsyst.cloudfront.net/beintv/tracks-v1a1/mono.m3u8"; 
const DELAY_MS = 30000; // Tam 30 saniye gecikme (30000 ms). İstersen 60000 yapıp 1 dakika da yapabilirsin.

app.get('/bein.m3u8', (req, res) => {
    // Tarayıcı ve oynatıcılar için en kararlı başlıklar
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');

    // Linkin HTTP veya HTTPS olmasına göre otomatik protokol seçimi
    const lib = TARGET_URL.startsWith('https') ? https : http;

    const upstreamReq = lib.get(TARGET_URL, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://www.google.com/"
        }
    }, (upstream) => {
        // Kaynak yayın 200 OK dönmezse hata fırlatmayalım, loglayalım
        if (upstream.statusCode !== 200) {
            res.status(upstream.statusCode).send("Kaynak yayın HTTP hata kodu döndürdü: " + upstream.statusCode);
            return;
        }

        let bufferQueue = [];
        let isClientConnected = true;

        // Gelen ham veriyi zaman damgasıyla kuyruğa atıyoruz
        upstream.on('data', (chunk) => {
            if (!isClientConnected) return;
            bufferQueue.push({
                chunk: chunk,
                receiveTime: Date.now()
            });
        });

        // Her 50 milisaniyede bir kuyruğu tarayıp, tam 30 saniyesi dolan veriyi dışarı salıyoruz
        const interval = setInterval(() => {
            if (!isClientConnected) {
                clearInterval(interval);
                return;
            }

            const now = Date.now();
            while (bufferQueue.length > 0 && (now - bufferQueue[0].receiveTime) >= DELAY_MS) {
                const item = bufferQueue.shift();
                try {
                    res.write(item.chunk);
                } catch (err) {
                    // Kullanıcı oynatıcıyı kapattıysa yazmayı kes
                    isClientConnected = false;
                    break;
                }
            }
        }, 50);

        // Kullanıcı yayından çıktığında (veya ExoPlayer'ı kapattığında) sunucu belleğini anında temizliyoruz
        req.on('close', () => {
            isClientConnected = false;
            clearInterval(interval);
            upstream.destroy(); // Kaynak bağlantısını kopararak sunucuyu boşa harcama yapmaktan koruyoruz
        });

        upstream.on('error', (err) => {
            console.error("Kaynak akış hatası:", err.message);
        });

    });

    upstreamReq.on('error', (err) => {
        if (!res.headersSent) {
            res.status(500).send("Proxy Bağlantı Hatası: " + err.message);
        }
    });
});

app.listen(PORT, () => {
    console.log(`Buffer proxy ${PORT} portunda kusursuz şekilde çalışıyor...`);
});
