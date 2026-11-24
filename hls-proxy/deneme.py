import logging
import math
import os
import signal
import threading
import time
import hashlib
from dataclasses import dataclass
from typing import List, Optional
from urllib.parse import urljoin, urlparse

import requests
from flask import Flask, Response, jsonify, request
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

SOURCE_M3U8 = os.getenv("SOURCE_M3U8", "")
SOURCE_M3U8S = [url.strip() for url in os.getenv("SOURCE_M3U8S", SOURCE_M3U8).split("|") if url.strip()]
LAG_SEC = float(os.getenv("LAG_SEC", "9.0"))          # Kaynaktan 5-10 sn geriden gelme hedefi
TARGET_BUFFER_SEC = float(os.getenv("TARGET_BUFFER_SEC", "28.0"))  # 26-30 sn hedefli tampon penceresi
MIN_BUFFER_SEC = float(os.getenv("MIN_BUFFER_SEC", "20.0"))        # 20 sn altına inmeme alt sınırı
POLL_INTERVAL = float(os.getenv("POLL_INTERVAL", "2.0"))
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8081"))
STALE_AFTER_SEC = float(os.getenv("STALE_AFTER_SEC", "30"))
PLAYLIST_TOKEN = os.getenv("PLAYLIST_TOKEN", "")
PUBLIC_BASE_URL = (os.getenv("PUBLIC_BASE_URL") or os.getenv("RENDER_EXTERNAL_URL", "")).rstrip("/")
PROXY_SEGMENTS = os.getenv("PROXY_SEGMENTS", "1") == "1"

if LAG_SEC < 0 or TARGET_BUFFER_SEC <= 0 or MIN_BUFFER_SEC <= 0 or POLL_INTERVAL <= 0:
    raise ValueError("LAG_SEC >= 0 ve süre/aralık değerleri > 0 olmalı")
if MIN_BUFFER_SEC > TARGET_BUFFER_SEC:
    raise ValueError("MIN_BUFFER_SEC, TARGET_BUFFER_SEC değerinden büyük olamaz")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("lagged-hls")
app = Flask(__name__)

@dataclass
class Segment:
    duration: float
    uri: str
    sequence: int
    prefix: List[str]

@dataclass
class PlaylistState:
    body: str = ""
    updated_at: float = 0.0
    segment_count: int = 0
    window_duration: float = 0.0
    source_sequence: Optional[int] = None
    active_source_index: Optional[int] = None
    last_error: str = ""

state = PlaylistState()
lock = threading.Lock()
stop_event = threading.Event()
segment_map = {}
segment_map_lock = threading.Lock()
upstream_session: Optional[requests.Session] = None


def make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=1,
        connect=1,
        read=0,
        status=0,
        backoff_factor=0.1,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD"}),
        respect_retry_after_header=True,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=16, pool_maxsize=16)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({
        "User-Agent": "Lagged-HLS-Proxy/2.1",
        "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
    })
    return session


def parse_media_playlist(text: str, base_url: str):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not any(line == "#EXTM3U" for line in lines):
        raise ValueError("Kaynak geçerli bir M3U8 değil")
    if any(line.startswith("#EXT-X-STREAM-INF") for line in lines):
        raise ValueError("Kaynak master playlist; doğrudan media playlist URL'si gerekli")

    media_sequence = 0
    target_duration = 6
    pending_duration = None
    pending_tags: List[str] = []
    segments: List[Segment] = []

    for line in lines:
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            try:
                media_sequence = int(line.split(":", 1)[1])
            except ValueError:
                raise ValueError("Geçersiz EXT-X-MEDIA-SEQUENCE")
        elif line.startswith("#EXT-X-TARGETDURATION:"):
            try:
                target_duration = max(1, int(line.split(":", 1)[1]))
            except ValueError:
                pass
        elif line.startswith("#EXTINF:"):
            try:
                pending_duration = float(line.split(":", 1)[1].split(",", 1)[0])
            except (ValueError, IndexError):
                pending_duration = float(target_duration)
        elif not line.startswith("#") and pending_duration is not None:
            segments.append(Segment(
                duration=max(0.001, pending_duration),
                uri=urljoin(base_url, line),
                sequence=media_sequence + len(segments),
                prefix=list(pending_tags),
            ))
            pending_duration = None
            pending_tags.clear()
        elif line.startswith(("#EXT-X-KEY:", "#EXT-X-MAP:", "#EXT-X-DISCONTINUITY", "#EXT-X-PROGRAM-DATE-TIME:")):
            pending_tags.append(line)

    return segments, media_sequence, target_duration


def register_segment_token(uri: str) -> str:
    token = hashlib.sha256(uri.encode("utf-8")).hexdigest()[:24]
    with segment_map_lock:
        segment_map[token] = uri
        if len(segment_map) > 500:
            for old_key in list(segment_map.keys())[:-250]:
                del segment_map[old_key]
    return token


def build_lagged_m3u8(segments: List[Segment]) -> tuple[str, float, int]:
    if not segments:
        raise ValueError("Kaynak playlist segment içermiyor")

    total_duration = sum(s.duration for s in segments)

    # Hedef: en az MIN_BUFFER_SEC (20 sn) korunsun, idealde TARGET_BUFFER_SEC (28 sn) olsun.
    # Kaynakta yeterli uzunluk varsa LAG_SEC kadar geriden başla; pencere 20 sn altına düşmesin.
    desired_lag = LAG_SEC
    if total_duration - desired_lag < MIN_BUFFER_SEC:
        desired_lag = max(0.0, total_duration - MIN_BUFFER_SEC)

    skipped = 0.0
    end_idx = len(segments) - 1
    while end_idx > 0 and skipped < desired_lag:
        skipped += segments[end_idx].duration
        end_idx -= 1

    collected = 0.0
    start_idx = end_idx
    for i in range(end_idx, -1, -1):
        start_idx = i
        collected += segments[i].duration
        if collected >= TARGET_BUFFER_SEC:
            break

    # Eğer geriye doğru topladığımız süre MIN_BUFFER_SEC altındaysa, end_idx'i ileri çekerek 20 sn'yi koru
    if collected < MIN_BUFFER_SEC and len(segments) > 1:
        end_idx = len(segments) - 1
        collected = 0.0
        start_idx = end_idx
        for i in range(end_idx, -1, -1):
            start_idx = i
            collected += segments[i].duration
            if collected >= MIN_BUFFER_SEC:
                break

    window = segments[start_idx:end_idx + 1]
    window_sec = sum(s.duration for s in window)
    max_duration = max(s.duration for s in window)

    out = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{max(1, math.ceil(max_duration))}",
        f"#EXT-X-MEDIA-SEQUENCE:{window[0].sequence}",
    ]

    last_prefix = None
    for segment in window:
        prefix = tuple(segment.prefix)
        if prefix != last_prefix:
            out.extend(segment.prefix)
            last_prefix = prefix
        out.append(f"#EXTINF:{segment.duration:.3f},")
        if PROXY_SEGMENTS:
            token = register_segment_token(segment.uri)
            q = f"?token={PLAYLIST_TOKEN}" if PLAYLIST_TOKEN else ""
            out.append(f"{PUBLIC_BASE_URL}/segment/{token}{q}")
        else:
            out.append(segment.uri)

    return "\n".join(out) + "\n", window_sec, len(window)


def keep_ready_segments(session: requests.Session, segments: List[Segment]) -> List[Segment]:
    """Son segmentlerden başlayarak CDN'de gerçekten hazır olanları ayıklar."""
    ready_reversed = []
    for segment in reversed(segments):
        try:
            probe = session.head(segment.uri, timeout=(1.0, 1.5), allow_redirects=True)
            ok = probe.status_code in (200, 206)
            if probe.status_code == 405:
                probe.close()
                probe = session.get(segment.uri, headers={"Range": "bytes=0-1"}, timeout=(1.0, 2.0), stream=True)
                ok = probe.status_code in (200, 206)
            probe.close()
            if ok:
                ready_reversed.append(segment)
        except requests.RequestException as exc:
            log.debug("Segment henüz hazır değil (%s): %s", segment.sequence, exc)
    ready_reversed.reverse()
    return ready_reversed


def fetch_media_playlist(session: requests.Session, source_url: str):
    """Playlist'i sınırlı oku; sonsuz TS/video yanıtlarının failover'ı kilitlemesini önle."""
    response = session.get(source_url, timeout=(3, 10), stream=True)
    try:
        response.raise_for_status()
        chunks = []
        total_bytes = 0
        for chunk in response.iter_content(chunk_size=4096):
            if not chunk:
                continue
            if not chunks and not chunk.lstrip(b"\xef\xbb\xbf \r\n\t").startswith(b"#EXTM3U"):
                raise ValueError("Kaynak M3U8 playlist değil")
            total_bytes += len(chunk)
            if total_bytes > 1024 * 1024:
                raise ValueError("Playlist 1 MiB sınırını aştı")
            chunks.append(chunk)
        return b"".join(chunks).decode("utf-8-sig", errors="replace"), response.url
    finally:
        response.close()


def poller_loop():
    global upstream_session
    upstream_session = make_session()
    preferred_source = 0
    while not stop_event.is_set():
        errors = []
        source_order = list(range(preferred_source, len(SOURCE_M3U8S))) + list(range(0, preferred_source))
        updated = False
        for source_index in source_order:
            source_url = SOURCE_M3U8S[source_index]
            try:
                playlist_text, playlist_url = fetch_media_playlist(upstream_session, source_url)
                segments, sequence, _ = parse_media_playlist(playlist_text, playlist_url)
                # Segment CDN'leri sunucu tarafındaki HEAD isteklerini reddedebilir;
                # istemci segmentleri doğrudan kaynak URI'lerinden alır.
                if not segments:
                    raise ValueError("Kaynak playlistte segment yok")
                ready_segments = segments

                body, window_sec, seg_cnt = build_lagged_m3u8(ready_segments)
                with lock:
                    state.body = body
                    state.updated_at = time.time()
                    state.segment_count = seg_cnt
                    state.window_duration = window_sec
                    state.source_sequence = sequence
                    state.active_source_index = source_index + 1
                    state.last_error = ""
                preferred_source = source_index
                log.info(
                    "Kaynak %d/%d güncel: pencere=%.1fs (hedef=%.1fs, min=%.1fs), %d segment, sıra=%s",
                    source_index + 1, len(SOURCE_M3U8S), window_sec, TARGET_BUFFER_SEC,
                    MIN_BUFFER_SEC, seg_cnt, sequence,
                )
                updated = True
                break
            except Exception as exc:
                error_label = type(exc).__name__
                errors.append(f"Kaynak {source_index + 1}: {error_label}")
                log.warning("Kaynak %d/%d kullanılamadı (%s)", source_index + 1, len(SOURCE_M3U8S), error_label)

        if not updated:
            error_summary = "; ".join(errors) if errors else "SOURCE_M3U8S boş"
            with lock:
                state.last_error = error_summary
            log.warning("Hiçbir kaynak güncel playlist veremedi: %s", error_summary)

        stop_event.wait(POLL_INTERVAL)
    upstream_session.close()


def authorized() -> bool:
    if not PLAYLIST_TOKEN:
        return True
    supplied = request.args.get("token") or request.headers.get("X-Playlist-Token")
    return supplied == PLAYLIST_TOKEN


@app.after_request
def add_headers(response):
    response.headers["Access-Control-Allow-Origin"] = os.getenv("CORS_ORIGIN", "*")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    return response


@app.get("/index.m3u8")
def serve_playlist():
    if not authorized():
        return Response("Unauthorized\n", status=401, mimetype="text/plain")
    with lock:
        body, updated, error = state.body, state.updated_at, state.last_error
    if not body:
        return Response("Playlist henüz hazır değil\n", status=503, mimetype="text/plain")
    response = Response(body, status=200, mimetype="application/vnd.apple.mpegurl")
    if time.time() - updated > STALE_AFTER_SEC:
        response.headers["X-Playlist-Stale"] = "true"
        if error:
            response.headers["X-Playlist-Error"] = error[:200]
    return response


@app.get("/segment/<token>")
def serve_segment(token):
    """Kaynak segmentini paylaşılan session üzerinden aktarır; Range isteklerini taşır."""
    if not authorized():
        return Response("Unauthorized\n", status=401, mimetype="text/plain")
    with segment_map_lock:
        source_url = segment_map.get(token)
    if not source_url:
        return Response("Segment artık tamponda değil\n", status=404, mimetype="text/plain")

    sess = upstream_session or make_session()
    headers = {"User-Agent": "Lagged-HLS-Proxy/2.1"}
    if request.headers.get("Range"):
        headers["Range"] = request.headers["Range"]
    try:
        upstream = sess.get(source_url, headers=headers, timeout=(5, 20), stream=True)
        upstream.raise_for_status()
    except requests.RequestException as exc:
        log.warning("Segment alınamadı: %s", exc)
        return Response("Upstream segment alınamadı\n", status=502, mimetype="text/plain")

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    response = Response(generate(), status=upstream.status_code, direct_passthrough=True)
    for name in ("Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"):
        if upstream.headers.get(name):
            response.headers[name] = upstream.headers[name]
    return response


@app.get("/health")
def health():
    with lock:
        age = time.time() - state.updated_at if state.updated_at else None
        payload = {
            "ok": bool(state.body) and (age is not None and age <= STALE_AFTER_SEC),
            "age_sec": age,
            "segments": state.segment_count,
            "window_sec": round(state.window_duration, 2),
            "target_buffer_sec": TARGET_BUFFER_SEC,
            "min_buffer_sec": MIN_BUFFER_SEC,
            "lag_sec": LAG_SEC,
            "active_source": state.active_source_index,
            "source_count": len(SOURCE_M3U8S),
            "last_error": state.last_error,
        }
    return jsonify(payload), (200 if payload["ok"] else 503)


def shutdown(*_):
    log.info("Kapatma sinyali alındı")
    stop_event.set()


poller_start_lock = threading.Lock()
poller_started = False


def start_poller():
    global poller_started
    with poller_start_lock:
        if not poller_started:
            threading.Thread(target=poller_loop, name="playlist-poller", daemon=True).start()
            poller_started = True


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    start_poller()
    print(f"SONUC_LINK: {PUBLIC_BASE_URL}/index.m3u8", flush=True)
    app.run(host=HOST, port=PORT, threaded=True, use_reloader=False)
