window.__wpAdapter = {
  siteName: 'Netflix',
  getVideo() {
    return document.querySelector('video');
  },
  getOverlayParent() {
    return document.body;
  },

  // Netflix's DRM-protected player throws a playback error ("Pardon the
  // interruption", code M7375) whenever position is changed programmatically
  // — this held true both for direct video.currentTime writes AND simulated
  // arrow-key presses (Netflix appears to reject synthetic/untrusted input
  // for seeking specifically). There's no reliable script-driven seek left
  // to try, so Netflix opts out of auto-seeking entirely; content.js falls
  // back to a chat notification so the other viewer can seek manually with
  // Netflix's own scrubber, which is real user input and never triggers this.
  supportsProgrammaticSeek: false,
};
