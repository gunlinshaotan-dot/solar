/**
 * Solar Nemesis — browser live reload (SSE)
 * Only reloads when the server actually broadcasts (LIVE_RELOAD=1).
 */
(function () {
  if (window.__SOLAR_LIVE_RELOAD__) return;
  window.__SOLAR_LIVE_RELOAD__ = true;

  let es;
  let retryMs = 1500;

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
      console.log('[Solar Nemesis] live reload', reason);
      location.reload();
    });

    es.onopen = function () {
      retryMs = 1500;
    };

    es.onerror = function () {
      try { es.close(); } catch (_) {}
      // Reconnect quietly — do NOT reload the page on SSE errors
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 1.6, 8000);
    };
  }

  connect();
})();
