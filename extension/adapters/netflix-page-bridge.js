// Runs in the PAGE's own JS context (manifest "world": "MAIN"), not the
// isolated content-script sandbox — this is required to reach Netflix's
// internal player API (window.netflix...), which is what Netflix's own UI
// uses to seek/play/pause. Going through it (instead of writing
// video.currentTime or faking key presses) is why this doesn't trigger the
// "Pardon the interruption" DRM error: it's the same control path Netflix's
// own scrubber uses, not a script poking the media element from outside.
(function () {
  function getPlayer() {
    try {
      const videoPlayer = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const sessionId = videoPlayer.getAllPlayerSessionIds()[0];
      if (sessionId === undefined) return null;
      return videoPlayer.getVideoPlayerBySessionId(sessionId);
    } catch {
      return null;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'watchparty-bridge-request') return;

    let ok = false;
    try {
      const player = getPlayer();
      if (player) {
        if (data.action === 'seek') {
          player.seek(Math.round(data.timeSeconds * 1000));
          ok = true;
        } else if (data.action === 'play') {
          player.play();
          ok = true;
        } else if (data.action === 'pause') {
          player.pause();
          ok = true;
        }
      }
    } catch {
      ok = false;
    }
    window.postMessage({ source: 'watchparty-bridge-response', requestId: data.requestId, ok }, '*');
  });
})();
