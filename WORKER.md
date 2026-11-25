# Cloudflare Worker

Bu Worker, GitHub Actions tarafından güncellenen `streams/links.json` dosyasını okur; `/api/links` ile Worker oynatma adreslerini listeler ve `/stream/<kanal>.m3u8` üzerinden HLS playlist/segment isteklerini kaynak başlıklarıyla geçirir. `/proxy` uç noktası yalnızca Worker'ın HLS manifestinden ürettiği, süresi sınırlı HMAC imzalı URL'leri kabul eder.

## Dağıtım

Cloudflare hesabında Wrangler ile giriş yapıp Worker'ı dağıt:

```bash
npx wrangler@latest login
npx wrangler@latest deploy
```

Dağıtımdan sonra proxy imzalama anahtarını GitHub'a koymadan Cloudflare secret olarak ekle:

```bash
openssl rand -hex 32 | npx wrangler@latest secret put PROXY_SECRET
```

Secret eklendikten sonra Worker otomatik olarak yeni sürümde çalışır. `PROXY_SECRET` kodda veya `wrangler.toml` içinde tutulmamalıdır. Kaynak playlist başlıklarını üretmek için `https://taraftarium.xyz/` referer/origin değerleri kullanılır.

## Uç noktalar

- `/` — kanal listesini gösterir.
- `/healthz` — Worker ve links.json durumunu döndürür.
- `/api/links` — worker playlist adreslerini JSON olarak verir.
- `/stream/<kanal>.m3u8` — ilgili playlisti ve segmentlerini proxy üzerinden sunar.

`wrangler.toml` içindeki `LINKS_JSON_URL`, mevcut public GitHub `streams/links.json` dosyasını gösterir. Action dosyayı her 6 saatte bir güncellediği için Worker bağlantı listesini 60 saniyelik önbellekle okur.
