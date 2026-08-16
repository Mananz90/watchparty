// Talks to adapters/netflix-page-bridge.js (runs in the page's own JS world)
// via postMessage, since Netflix's internal player API isn't reachable from
// this isolated content-script context directly.
let wpBridgeReqId = 0;
function callNetflixBridge(action, timeSeconds) {
  return new Promise((resolve) => {
    const requestId = ++wpBridgeReqId;
    const timeout = setTimeout(() => { cleanup(); resolve(false); }, 1000);
    function handler(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== 'watchparty-bridge-response' || data.requestId !== requestId) return;
      cleanup();
      resolve(!!data.ok);
    }
    function cleanup() {
      clearTimeout(timeout);
      window.removeEventListener('message', handler);
    }
    window.addEventListener('message', handler);
    window.postMessage({ source: 'watchparty-bridge-request', action, timeSeconds, requestId }, '*');
  });
}

window.__wpAdapter = {
  siteName: 'Netflix',
  getVideo() {
    return document.querySelector('video');
  },
  getOverlayParent() {
    return document.body;
  },
  async seekTo(video, targetTime) {
    const ok = await callNetflixBridge('seek', targetTime);
    if (!ok) throw new Error('Netflix internal player API unavailable for seek');
  },
};
