window.__wpAdapter = {
  siteName: 'Netflix',
  getVideo() {
    return document.querySelector('video');
  },
  getOverlayParent() {
    return document.body;
  },

  // Netflix's DRM-protected player can throw a playback error ("Pardon the
  // interruption") when video.currentTime is set directly, especially for
  // large jumps. It tolerates seeks driven through its own player controls
  // much better, so we simulate the same arrow-key shortcuts Netflix's UI
  // uses (10s per press) instead of writing the property directly.
  async seekTo(video, targetTime) {
    const ARROW_STEP = 10; // seconds Netflix moves per arrow-key press
    const MAX_STEPS = 60;  // safety cap (~10 minutes) so a huge jump doesn't hammer the page
    const diff = targetTime - video.currentTime;
    const steps = Math.min(Math.round(Math.abs(diff) / ARROW_STEP), MAX_STEPS);
    if (steps === 0) return;
    const key = diff > 0 ? 'ArrowRight' : 'ArrowLeft';

    for (let i = 0; i < steps; i++) {
      const opts = { key, code: key, bubbles: true, cancelable: true };
      document.dispatchEvent(new KeyboardEvent('keydown', opts));
      document.dispatchEvent(new KeyboardEvent('keyup', opts));
      await new Promise((r) => setTimeout(r, 120)); // Netflix needs spacing between presses to register each one
    }
  },
};
