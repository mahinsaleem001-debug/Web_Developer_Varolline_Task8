/* Live connection to one board (Server-Sent Events) with the failure handling a real network needs:
   - the browser reconnects by itself and sends Last-Event-ID, so the server replays what was missed
   - a watchdog restarts the stream if the server goes silent (the server pings every 15 s)
   - if the browser gives up (stream CLOSED) we retry with exponential backoff + jitter
   - going offline / coming back online and tab visibility are handled
   Status shown to the user: connecting | live | reconnecting | offline */
(function (w) {
  'use strict';
  const EVENT_TYPES = ['task.created', 'task.updated', 'task.moved', 'task.deleted', 'comment.created', 'comment.deleted',
    'column.created', 'column.updated', 'column.deleted', 'member.added', 'member.removed', 'board.updated'];
  const SILENCE_LIMIT = 40000;

  function connect(o) {
    let es = null, stopped = false, status = '', everOpen = false, attempt = 0, lastMsg = Date.now(), retryTimer = null;

    const setStatus = (s) => { if (s !== status) { status = s; o.onStatus(s); } };
    const json = (m) => { try { return JSON.parse(m.data); } catch (e) { return null; } };

    function open() {
      if (stopped) return;
      if (es) { es.close(); es = null; }
      setStatus(everOpen ? 'reconnecting' : 'connecting');
      es = new EventSource('/api/boards/' + o.boardId + '/events?since=' + o.getVersion());
      const mine = es;
      mine.onopen = () => { attempt = 0; everOpen = true; lastMsg = Date.now(); setStatus('live'); };
      mine.onerror = () => {
        if (stopped || mine !== es) return;
        setStatus(navigator.onLine === false ? 'offline' : 'reconnecting');
        if (mine.readyState === EventSource.CLOSED) scheduleRetry(); // the browser will not retry by itself any more
      };
      EVENT_TYPES.forEach((t) => mine.addEventListener(t, (m) => { lastMsg = Date.now(); const e = json(m); if (e) o.onEvent(e); }));
      mine.addEventListener('hello', (m) => { lastMsg = Date.now(); const e = json(m); if (e) o.onHello(e.connId, e.version); });
      mine.addEventListener('presence', (m) => { lastMsg = Date.now(); const e = json(m); if (e) o.onPresence(e.users); });
      mine.addEventListener('resync', (m) => { lastMsg = Date.now(); const e = json(m); o.onResync(e && e.reason); });
      mine.addEventListener('removed', () => { stop(); o.onRemoved(); });
      mine.addEventListener('board.deleted', () => { stop(); o.onBoardDeleted(); });
      mine.addEventListener('ping', () => { lastMsg = Date.now(); });
    }

    // The stream was closed for good (e.g. the server answered 401/404/5xx). Find out why, then retry politely.
    function scheduleRetry() {
      clearTimeout(retryTimer);
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt++)) + Math.floor(Math.random() * 500);
      retryTimer = setTimeout(async () => {
        if (stopped) return;
        try {
          await w.Api.get('/api/boards/' + o.boardId + '/version');   // 401 -> session handler, 404 -> removed
          open();
        } catch (e) {
          if (e.status === 404) { stop(); o.onRemoved(); }
          else if (e.status === 401) stop();
          else scheduleRetry();
        }
      }, delay);
    }

    const watchdog = setInterval(() => {
      if (stopped || !es) return;
      if (status === 'live' && Date.now() - lastMsg > SILENCE_LIMIT) { setStatus('reconnecting'); open(); }
    }, 5000);

    // After the network comes back the old stream may look open but be dead, so always start a fresh one.
    // Nothing is lost: the server replays everything after our last version.
    const onOnline = () => { if (stopped) return; attempt = 0; open(); };
    const onOffline = () => { if (!stopped) setStatus('offline'); };
    const onVisible = () => { if (!document.hidden && !stopped && (!es || es.readyState === EventSource.CLOSED)) open(); };
    w.addEventListener('online', onOnline);
    w.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);

    function stop() {
      stopped = true;
      clearInterval(watchdog); clearTimeout(retryTimer);
      w.removeEventListener('online', onOnline); w.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      if (es) { es.close(); es = null; }
    }

    open();
    return { close: stop, reconnect: () => { attempt = 0; open(); } };
  }

  w.Live = { connect };
})(window);
