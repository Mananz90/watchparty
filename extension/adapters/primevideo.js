window.__wpAdapter = {
  siteName: 'Prime Video',
  getVideo() {
    // Prime's pages often leave multiple <video> elements in the DOM at once
    // (background preview clips, carousel thumbnails, X-Ray panels) even
    // after the real player is open — grabbing the first one in the DOM can
    // silently bind to the wrong, invisible video. Picking the largest
    // currently-visible one reliably lands on the actual main player instead.
    const candidates = [...document.querySelectorAll('video')].filter((v) => {
      const rect = v.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(v).visibility !== 'hidden';
    });
    if (candidates.length === 0) return null;
    return candidates.reduce((biggest, v) => {
      const area = (r) => r.width * r.height;
      return area(v.getBoundingClientRect()) > area(biggest.getBoundingClientRect()) ? v : biggest;
    });
  },
  getOverlayParent() {
    return document.body;
  },
};
