import { useEffect, useRef, useState } from 'react';
import { api, apiUrl } from './api';

/**
 * LivePlayer — requests an authorized HLS session for a camera and plays it in
 * the browser via hls.js (or native HLS on Safari). The frontend never receives
 * the RTSP URL or credentials — only a short-lived signed manifest URL served by
 * the API. The manifest + segment requests carry the session cookie so the
 * server re-authorizes tenant + camera ownership on every fetch.
 */
export function LivePlayer({ cameraId, onClose }: { cameraId: string; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let hls: import('hls.js').default | null = null;
    let cancelled = false;

    (async () => {
      try {
        // Code-split hls.js so it only loads when a stream is opened.
        const { default: Hls } = await import('hls.js');
        const res = await api.get<{ live: { manifestUrl: string; protocol: string } }>(`/cameras/${cameraId}/live`);
        if (cancelled) return;
        // Absolutize against the API origin so hls.js fetches the manifest +
        // segments from api.garudai.in (with credentials), not the web origin.
        const url = apiUrl(res.live.manifestUrl);
        const video = videoRef.current;
        if (!video) return;

        if (Hls.isSupported()) {
          hls = new Hls({
            lowLatencyMode: true,
            enableWorker: true,
            // Send the session cookie cross-site so the API can authorize each
            // manifest/segment request (the signed URL is verified server-side too).
            xhrSetup: (xhr) => {
              xhr.withCredentials = true;
            },
          });
          hls.loadSource(url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            setLoading(false);
            void video.play().catch(() => undefined);
          });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setError('Stream is starting or unavailable. Retry shortly.');
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Native HLS (Safari).
          video.src = url;
          video.addEventListener('loadedmetadata', () => {
            setLoading(false);
            void video.play().catch(() => undefined);
          });
        } else {
          setError('HLS is not supported in this browser.');
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unable to start live stream');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (hls) hls.destroy();
    };
  }, [cameraId]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Live stream</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          Authorized HLS session. The camera's RTSP URL and password never reach the browser.
        </p>
        <div style={{ position: 'relative', background: '#05070f', borderRadius: 10, overflow: 'hidden' }}>
          <video ref={videoRef} controls muted playsInline style={{ width: '100%', aspectRatio: '16/9', display: 'block' }} />
          {loading && !error && (
            <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--muted)' }}>
              Connecting to stream…
            </div>
          )}
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row-actions" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
