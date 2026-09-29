/**
 * `curl` against the estate's internal HTTP endpoints.
 *
 *   makeCurl(ctx, routes)   routes: { 'host/path': (request) => ({ status, body, headers? }) }
 *   A route key without a path ('host') answers every path on that host. `request` is
 *   { method, path, query, headers, body, host }. Any other host does not resolve, which is what an
 *   internal name looks like from outside the network it lives in.
 */
const REASONS = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

export function makeCurl(ctx, routes) {
  return function curl(argv, io) {
    let silent = false, showError = false, fail = false, include = false, head = false, output = null, write = null, method = null, url = null, verbose = false, location = false;
    const headers = {};
    let body = null, get = false;
    const encoded = [];
    const urlencode = (x) => { const eq = x.indexOf('='); return eq < 0 ? encodeURIComponent(x) : `${x.slice(0, eq)}=${encodeURIComponent(x.slice(eq + 1))}`; };
    for (let k = 0; k < argv.length; k++) {
      const a = argv[k];
      const next = () => argv[++k];
      if (a === '-s' || a === '--silent') silent = true;
      else if (a === '-S' || a === '--show-error') showError = true;
      else if (a === '-f' || a === '--fail') fail = true;
      else if (a === '-i' || a === '--include') include = true;
      else if (a === '-I' || a === '--head') head = true;
      else if (a === '-v' || a === '--verbose') verbose = true;
      else if (a === '-L' || a === '--location') location = true;
      else if (a === '-o' || a === '--output') output = next();
      else if (a === '-w' || a === '--write-out') write = next();
      else if (a === '-X' || a === '--request') method = next();
      else if (a === '-H' || a === '--header') { const h = next() ?? ''; const c = h.indexOf(':'); if (c > 0) headers[h.slice(0, c).trim().toLowerCase()] = h.slice(c + 1).trim(); }
      else if (a === '-d' || a === '--data' || a === '--data-raw' || a === '--data-binary') encoded.push(next() ?? '');
      else if (a === '--data-urlencode') encoded.push(urlencode(next() ?? ''));
      else if (a.startsWith('--data-urlencode=')) encoded.push(urlencode(a.slice(17)));
      else if (a === '-G' || a === '--get') get = true;
      else if (a === '-m' || a === '--max-time' || a === '--connect-timeout' || a === '-u' || a === '--user' || a === '-A' || a === '--user-agent' || a === '--retry') next();
      else if (a === '-k' || a === '--insecure' || a === '--compressed') { /* no effect here */ }
      else if (/^-[a-zA-Z]{2,}$/.test(a)) {
        for (const ch of a.slice(1)) {
          if (ch === 'G') get = true; else if (ch === 's') silent = true; else if (ch === 'S') showError = true; else if (ch === 'f') fail = true; else if (ch === 'i') include = true; else if (ch === 'I') head = true; else if (ch === 'L') location = true; else if (ch === 'v') verbose = true; else if (ch === 'k') { /* insecure */ }
          else return { err: [`curl: option ${a}: is unknown`, "curl: try 'curl --help' or 'curl --manual' for more information"], code: 2 };
        }
      }
      else if (a.startsWith('-')) return { err: [`curl: option ${a}: is unknown`, "curl: try 'curl --help' or 'curl --manual' for more information"], code: 2 };
      else url = a;
    }
    void location;
    if (!url) return { err: ["curl: try 'curl --help' or 'curl --manual' for more information"], code: 2 };
    // -G sends the data as the query string of a GET; otherwise it is the body, joined with &.
    if (encoded.length && get) url += (url.includes('?') ? '&' : '?') + encoded.join('&');
    else if (encoded.length) body = encoded.join('&');
    const m = /^(?:(https?):\/\/)?([^/:?#]+)(?::(\d+))?([^?#]*)(?:\?([^#]*))?/.exec(url);
    if (!m) return { err: [`curl: (3) URL using bad/illegal format or missing URL`], code: 3 };
    const [, , host, , rawPath, query = ''] = m;
    const path = rawPath || '/';
    const handler = routes[`${host}${path.replace(/\/$/, '') || '/'}`] ?? routes[`${host}${path}`] ?? routes[host] ?? (host.endsWith('.googleapis.com') ? googleFrontEnd : undefined);
    ctx.wait(1);
    // A failed transfer still prints --write-out, with the code curl had: 000 when nothing answered.
    const errOut = (code, message) => ({ err: silent && !showError ? [] : [`curl: (${code}) ${message}`], code, out: write ? expand(write, '000', '').split('\n').filter((l, k, all) => k < all.length - 1 || l !== '') : [] });
    if (!handler && !Object.keys(routes).some(k => k.split('/')[0] === host)) return errOut(6, `Could not resolve host: ${host}`);
    const request = { method: method ?? (body !== null ? 'POST' : head ? 'HEAD' : 'GET'), path, query: Object.fromEntries(new URLSearchParams(query)), headers, body, host };
    const res = handler ? handler(request) : { status: 404, body: '{"error":"not found"}\n' };
    const status = res.status;
    const text = typeof res.body === 'string' ? res.body : `${JSON.stringify(res.body)}\n`;
    const responseHeaders = [`HTTP/1.1 ${status} ${REASONS[status] ?? ''}`.trim(), `content-type: ${res.contentType ?? (typeof res.body === 'string' && !res.body.startsWith('{') ? 'text/plain; charset=utf-8' : 'application/json')}`, `date: ${ctx.now().toUTCString()}`, `content-length: ${Buffer.byteLength(text)}`, ...(res.headers ?? []), ''];
    const out = [];
    const err = [];
    if (verbose) err.push(`*   Trying ${res.ip ?? '10.10.0.12'}:${url.startsWith('https') ? 443 : 80}...`, `* Connected to ${host} (${res.ip ?? '10.10.0.12'}) port ${url.startsWith('https') ? 443 : 80}`, `> ${request.method} ${path}${query ? `?${query}` : ''} HTTP/1.1`, `> Host: ${host}`, '> User-Agent: curl/7.88.1', '> Accept: */*', '>', ...responseHeaders.map(h => `< ${h}`));
    if (fail && status >= 400) return { err: [...err, ...(silent && !showError ? [] : [`curl: (22) The requested URL returned error: ${status}`])], code: 22, out: write ? [expand(write, status, text)] : [] };
    let shown = [];
    if (head) shown = responseHeaders;
    else {
      if (include) shown.push(...responseHeaders);
      const bodyLines = text.split('\n');
      if (bodyLines.at(-1) === '') bodyLines.pop();
      if (output && output !== '/dev/null') {
        const problem = io.sh.writeFile(output, text);
        if (problem) return { err: [`curl: (23) Failure writing output to destination`], code: 23 };
      } else if (output !== '/dev/null') shown.push(...bodyLines);
    }
    out.push(...shown);
    if (write) { const w = expand(write, status, text); if (out.length && !text.endsWith('\n') && !head && !output) out[out.length - 1] += w.split('\n')[0]; else out.push(...w.split('\n').filter((_, k, all) => k < all.length - 1 || all[k] !== '')); }
    return { out, err };
  };
}
/**
 * Google's API hosts resolve from anywhere. A path the estate does not model answers the way
 * Google's front end answers an unknown URL; a request without a token is refused first.
 */
function googleFrontEnd(request) {
  if (!request.headers.authorization) return { status: 401, body: `${JSON.stringify({ error: { code: 401, message: 'Request is missing required authentication credential. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.', status: 'UNAUTHENTICATED' } }, null, 2)}\n` };
  return { status: 404, contentType: 'text/html; charset=UTF-8', body: `<!DOCTYPE html>\n<html lang=en>\n  <meta charset=utf-8>\n  <title>Error 404 (Not Found)!!1</title>\n  <p><b>404.</b> <ins>That’s an error.</ins>\n  <p>The requested URL <code>${request.path}</code> was not found on this server.  <ins>That’s all we know.</ins>\n` };
}
function expand(format, status, text) {
  return format.replace(/%\{http_code\}/g, String(status)).replace(/%\{response_code\}/g, String(status)).replace(/%\{size_download\}/g, String(Buffer.byteLength(text))).replace(/%\{time_total\}/g, '0.084512').replace(/\\n/g, '\n');
}
