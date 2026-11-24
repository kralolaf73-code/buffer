# Lagged HLS Proxy

Flask tabanlı, birden fazla yetkili HLS kaynağı arasında geçiş yapan playlist proxy'si.

## Render ayarları

- Service type: Web Service
- Runtime: Python
- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn --worker-class gthread --workers 1 --threads 8 --config gunicorn.conf.py deneme:app`
- Health check path (optional): `/health`

Render Dashboard > Environment bölümünde aşağıdaki değişkenleri ayarlayın. Kaynak URL'lerini veya token'ı Git deposuna eklemeyin.

- `SOURCE_M3U8S`: Yetkili playlist URL'lerini `|` ile ayırın; öncelik sırasına göre yazın.
- `PLAYLIST_TOKEN`: Güçlü, rastgele bir erişim anahtarı.
- `PROXY_SEGMENTS`: `1`
- `POLL_INTERVAL`: `2`
- `LAG_SEC`: `9`
- `TARGET_BUFFER_SEC`: `28`
- `MIN_BUFFER_SEC`: `20`

Render'ın otomatik `RENDER_EXTERNAL_URL` değeri segment URL'leri için kullanılır. Ücretsiz serviste gelen trafik 15 dakika boyunca olmazsa servis uykuya geçer; ilk sonraki istek servisi uyandırır. Ücretsiz bant genişliği, akış izleyicilerinin kullanımına göre yeterli olmayabilir.

Kaynak playlist'lerin ve segmentlerinin hizmet ortamından erişilebilir olması, ayrıca akışları yeniden iletme hakkının bulunması gerekir.
