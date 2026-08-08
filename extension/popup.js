function randomRoomCode() {
  const words = ['movie', 'popcorn', 'stream', 'party', 'night', 'crew', 'cinema'];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(Math.random() * 9000) + 1000;
  return `${w}-${n}`;
}

document.addEventListener('DOMContentLoaded', () => {
  const roomInput = document.getElementById('roomInput');
  const nameInput = document.getElementById('nameInput');

  chrome.storage.local.get(['wpRoomId', 'wpName'], (data) => {
    if (data.wpRoomId) roomInput.value = data.wpRoomId;
    if (data.wpName) nameInput.value = data.wpName;
  });

  document.getElementById('newRoomBtn').addEventListener('click', () => {
    roomInput.value = randomRoomCode();
  });

  document.getElementById('joinBtn').addEventListener('click', async () => {
    const roomId = roomInput.value.trim();
    const name = nameInput.value.trim() || 'Guest';
    if (!roomId) return;

    chrome.storage.local.set({ wpRoomId: roomId, wpName: name });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'wp-join', roomId, name });
    }
    window.close();
  });

  document.getElementById('copyLinkBtn').addEventListener('click', async () => {
    let roomId = roomInput.value.trim();
    if (!roomId) {
      roomId = randomRoomCode();
      roomInput.value = roomId;
    }
    const name = nameInput.value.trim() || 'Guest';
    chrome.storage.local.set({ wpRoomId: roomId, wpName: name });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;

    const url = new URL(tab.url);
    url.searchParams.set('wp_room', roomId);

    await navigator.clipboard.writeText(url.toString());
    const status = document.getElementById('copyStatus');
    status.style.display = 'block';
    setTimeout(() => { status.style.display = 'none'; }, 2000);
  });
});
