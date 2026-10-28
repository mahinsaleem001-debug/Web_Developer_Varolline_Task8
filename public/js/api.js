/* Thin fetch wrapper: JSON in/out, timeout, CSRF header, and one error type with a human message. */
(function (w) {
  'use strict';

  class ApiError extends Error {
    constructor(o) {
      super(o.message);
      this.status = o.status || 0;      // 0 = no response at all
      this.code = o.code || 'ERROR';
      this.fields = o.fields || null;   // { fieldName: message } for validation errors
      this.network = !!o.network;       // true when the request never reached the server
    }
  }

  const Api = { ApiError, onUnauthorized: null, onBoardVersion: null, clientId: null };

  async function request(method, url, body, opts) {
    const o = opts || {};
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), o.timeout || 10000);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'X-Requested-With': 'taskflow' },
          Api.clientId ? { 'X-Client-Id': Api.clientId } : {},          // which browser tab made the change
          o.idem ? { 'Idempotency-Key': o.idem } : {}                   // lets the server ignore a retried duplicate
        ),
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        signal: ctl.signal
      });
    } catch (e) {
      throw new ApiError({
        network: true,
        message: e.name === 'AbortError' ? 'The server took too long to answer. Please try again.' : 'Could not reach the server. Check your internet connection and try again.'
      });
    } finally { clearTimeout(timer); }

    let data = null;
    try { data = await res.json(); } catch (e) { /* empty or non-JSON body */ }

    if (!res.ok) {
      const err = (data && data.error) || {};
      const e = new ApiError({ status: res.status, code: err.code, fields: err.fields, message: err.message || 'Request failed (' + res.status + ').' });
      e.conflicts = err.conflicts || null; e.current = err.current || null;
      if (res.status === 401 && !o.noAuthRedirect && Api.onUnauthorized) Api.onUnauthorized(e);
      throw e;
    }
    const v = res.headers.get('X-Board-Version');
    if (v && Api.onBoardVersion) Api.onBoardVersion(Number(res.headers.get('X-Board-Id')), Number(v));
    return data;
  }

  Api.get = (u, o) => request('GET', u, undefined, o);
  Api.post = (u, b, o) => request('POST', u, b || {}, o);
  Api.patch = (u, b, o) => request('PATCH', u, b || {}, o);
  Api.del = (u, o) => request('DELETE', u, undefined, o);
  w.Api = Api;
})(window);
