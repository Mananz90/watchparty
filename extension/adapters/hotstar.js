window.__wpAdapter = {
  siteName: 'Hotstar',
  getVideo() {
    return document.querySelector('video');
  },
  getOverlayParent() {
    return document.body;
  },
  // Hotstar's player doesn't reliably fire 'seeking'/'seeked' for skip-button
  // taps, especially short in-buffer jumps — event-based detection silently
  // missed real seeks here. Polling currentTime directly doesn't depend on
  // any specific event firing at all. Scoped to Hotstar only via this
  // per-adapter config, so it can't affect Netflix or Prime Video, which
  // already work fine with the event-based approach.
  syncConfig: {
    usePolling: true,
    pollIntervalMs: 350,
    minCorrectionGapMs: 600, // Hotstar uses a plain currentTime write (no DRM bridge), so it can catch up faster than the Netflix-oriented default
  },
};
