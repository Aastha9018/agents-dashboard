// Service worker: lets alerts carry buttons. The main button (and a click on the alert) jumps to the session.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  n.close();
  if (e.action === 'ignore') return;
  const key = n.data && n.data.key;
  if (!key) return;
  e.waitUntil(
    fetch('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) }).catch(() => {}),
  );
});
