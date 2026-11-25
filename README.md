# HLS bağlantı proxy’si

GitHub Action (`.github/workflows/update-links.yml`) bağlantıları 6 saatte bir yeniler ve `streams/links.json` dosyasını değişiklik varsa depoya gönderir. Render’daki Express proxy bu public JSON’u düzenli aralıkla okur; Render servisi aynı GitHub deposundaki `main` dalına bağlanıp otomatik deploy da almalıdır.

## Render Web Service ayarları

- Project: `buffer-hls-proxy`
- Repository: `kralolaf73-code/buffer`
- Branch: `main`
- Build command: `npm ci --no-audit --no-fund`
- Start command: `npm start`
- Health check path: `/healthz`
- Node.js: 22
- Test aşamasında compute plan: Free

Render’ın verdiği `onrender.com` adresinde ana sayfa kanal listesini, `/healthz` servis durumunu, `/api/streams` JSON listesini sunar. M3U8 master listeleri `/streams/stream_<kanal>.m3u8`, proxy’li canlı listeler `/live/<kanal>.m3u8` uç noktalarında bulunur.

## Kaynak erişimi ve kullanım

Render servisi kaynak HLS uç noktalarına istek atarken `User-Agent`, `Referer` ve `Origin` başlıkları gönderir; playlist ve segment URL’lerini proxy adreslerine dönüştürür. Render’ın dış IP’leri farklı olduğundan kaynak sunucu HTTP 403 verebilir; bunu yalnızca Render deploy’ından sonra gerçek playlist/segment testleriyle doğrulamak mümkündür. HLS video çıkış trafiği Render bandwidth kotasına dahildir. Yalnızca kullanma hakkınız olan içeriklerle kullanın.
