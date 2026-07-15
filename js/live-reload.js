/**
 * Solar Memesis — browser live reload client (SSE)
 * Python watcher → Node /__reload → this reloads the page (F5)
 */
(function () {
  if (window.__SOLAR_LIVE_RELOAD__) return;
  window.__SOLAR_LIVE_RELOAD__ = true;

  let es;
  let retryMs = 800;

  function connect() {
    try {
      es = new EventSource('/__events');
    } catch (e) {
      setTimeout(connect, retryMs);
      return;
    }

    es.addEventListener('reload', function (ev) {
      let reason = '';
      try { reason = JSON.parse(ev.data).reason || ''; } catch (_) {}
      console.log('[Solar Memesis] live reload', reason);
      // Full refresh like F5
      location.reload();
    });

    es.onopen = function () {
      retryMs = 800;
      console.log('[Solar Memesis] live reload connected');
    };

    es.onerror = function () {
      es.close();
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 1.5, 5000);
    };
  }

  connect();
})();
