/**
 * GeolocationAPI
 *
 * Auth is passed via ?subscription-key= query parameter so that no custom
 * request headers are needed — this keeps GET requests CORS-preflight-free
 * and POST preflights passing with only Content-Type allowed.
 */
class GeolocationAPI {
  static MAX_RETRIES = 3;
  static TIMEOUT_MS  = 15_000;

  /**
   * @param {string} endpoint  - Base URL
   * @param {string} apiKey    - Subscription key
   */
  constructor(endpoint, apiKey) {
    if (!apiKey)    throw new Error('API key is required.');
    if (!endpoint)  throw new Error('Endpoint is required.');
    this.endpoint = endpoint.replace(/\/$/, '');
    this.apiKey   = apiKey;
  }

  // ── Private helpers ──────────────────────────────────────────

  /**
   * Build a full URL with subscription-key appended as a query parameter.
   * Using a query param instead of the header avoids
   * triggering a CORS preflight on GET requests.
   */
  _url(path) {
    const sep = path.includes('?') ? '&' : '?';
    return `${this.endpoint}${path}${sep}subscription-key=${encodeURIComponent(this.apiKey)}`;
  }

  /**
   * Headers to send. GET requests need none (no custom headers = no preflight).
   * POST requests need Content-Type, which the API explicitly allows in preflights.
   */
  _headers(method = 'GET') {
    return method === 'POST' ? { 'Content-Type': 'application/json' } : {};
  }

  /**
   * Core fetch wrapper — mirrors _call_api() in Python.
   * Retries up to MAX_RETRIES times on HTTP 504.
   *
   * @param {string} url        - Full URL (including subscription-key param)
   * @param {'GET'|'POST'} method
   * @param {object|null}  body
   * @returns {Promise<Response>}
   */
  async _callApi(url, method = 'GET', body = null) {
    let retries = 0;

    while (retries < GeolocationAPI.MAX_RETRIES) {
      const opts = {
        method,
        headers: this._headers(method),
        signal: AbortSignal.timeout(GeolocationAPI.TIMEOUT_MS),
      };
      if (body !== null) opts.body = JSON.stringify(body);

      const res = await fetch(url, opts);

      if (res.status === 504) {
        retries++;
        console.warn(`[GeolocationAPI] 504 Gateway Timeout. Retry ${retries}/${GeolocationAPI.MAX_RETRIES}…`);
        continue;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${detail ? ': ' + detail.slice(0, 200) : ''}`);
      }

      return res;
    }

    throw new Error(
      `Request failed after ${GeolocationAPI.MAX_RETRIES} retries (504 Gateway Timeout).`
    );
  }

  // ── Public API methods ───────────────────────────────────────


  /**
   * GET /stores/{storeId}/floors/{floorId}
   * Mirrors get_floor_svg() — returns raw SVG string.
   *
   * @param {string} storeId
   * @param {string} floorId
   * @returns {Promise<string>}
   */
  async getFloorSvg(storeId, floorId) {
    const url = this._url(`/stores/${storeId}/floors/${floorId}`);
    const res = await this._callApi(url);
    return res.text();
  }

  /**
   * GET /stores/{storeId}
   * Mirrors get_aisles() — filters to ACTIVE aisles and their ACTIVE modulars.
   *
   * @param {string} storeId
   * @returns {Promise<Array<{aisleId, name, floorId, modulars}>>}
   */
  async getStore(storeId) {
    const url  = this._url(`/stores/${storeId}`);
    const res  = await this._callApi(url);
    const data = await res.json();

    return data
      .filter(a => a.status === 'ACTIVE')
      .map(a => ({
        aisleId:  a.aisleId,
        name:     a.name,
        floorId:  a.floorId,
        modulars: (a.modulars ?? [])
          .filter(m => m.status === 'ACTIVE')
          .map(m => ({ modularId: m.modularId, name: m.name })),
      }));
  }

}
