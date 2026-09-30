import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import worker from '../src/index.js';

const errorHtml = await readFile(new URL('../frontend/error.html', import.meta.url), 'utf8');
const robots = await readFile(new URL('../frontend/robots.txt', import.meta.url), 'utf8');
const env = {
  PREFIX: '/', WHITE_LIST: 'HITSZ-OpenAuto', USE_JSDELIVR: '0', ALLOWED_ORIGINS: 'hoa.moe',
  ASSETS: { async fetch(request) {
    const path = new URL(request.url).pathname;
    assert.equal(request.method, 'GET');
    return new Response(path === '/error' ? errorHtml : path === '/robots.txt' ? robots : 'frontend', {
      headers: { 'content-type': path === '/robots.txt' ? 'text/plain' : 'text/html' },
    });
  } },
};
const request = (path, init, overrides) => worker.fetch(new Request(`https://fastdl.example${path}`, init), { ...env, ...overrides });
const noindex = response => assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive, nosnippet');

for (const path of ['/2026', '/missing', '/github.com/HITSZ-OpenAuto', '/https://example.com/file', '/2026?code=403&msg=Forbidden']) {
  test(`unmatched ${path} returns direct 404 and error HTML`, async () => {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('location'), null);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(await response.text(), errorHtml);
    assert.match(errorHtml, /<meta name="robots" content="noindex"/);
    noindex(response);
  });
}

test('unmatched routes also work with a configured prefix', async () => {
  const response = await request('/gh/2026', undefined, { PREFIX: '/gh/' });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('location'), null);
});

test('HEAD returns direct 404 without a body', async () => {
  const response = await request('/2026', { method: 'HEAD' });
  assert.equal(response.status, 404);
  assert.equal(await response.text(), '');
  noindex(response);
});

test('missing assets fall back to a direct 404', async () => {
  for (const ASSETS of [undefined, { fetch: async () => new Response(null, { status: 302, headers: { location: '/error/' } }) }]) {
    const response = await request('/2026', undefined, { ASSETS });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('location'), null);
    assert.equal(await response.text(), 'Not Found');
  }
});

test('error UI identifies direct 404s and preserves explicit error-page messages', () => {
  const script = errorHtml.match(/<script>([\s\S]*?)<\/script>/)[1];
  for (const [pathname, search, code, msg] of [
    ['/2026', '?code=403&msg=Forbidden', '404', 'Resource not found'],
    ['/error', '?code=403&msg=owner+is+not+allowed', '403', 'owner is not allowed'],
  ]) {
    const elements = { code: {}, msg: {} };
    const document = { getElementById: id => elements[id] };
    vm.runInNewContext(script, { location: { pathname, search }, URLSearchParams, document });
    assert.equal(elements.code.textContent, code);
    assert.equal(elements.msg.textContent, msg);
    assert.equal(document.title, `Error Code ${code}`);
  }
});

test('frontend, explicit error page and crawlable robots remain unchanged', async () => {
  for (const path of ['/', '/index.html']) assert.equal((await request(path)).status, 200);
  const error = await request('/error?code=403&msg=Forbidden');
  assert.equal(error.status, 403);
  assert.equal(await error.text(), errorHtml);
  const response = await request('/robots.txt');
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'User-agent: *\nAllow: /\n');
  noindex(response);
});

test('q and jsDelivr redirects retain their status and noindex headers', async () => {
  const q = await request('/download?q=github.com/HITSZ-OpenAuto/repo/archive/main.zip');
  assert.equal(q.status, 301);
  assert.equal(q.headers.get('location'), 'https://fastdl.example/github.com/HITSZ-OpenAuto/repo/archive/main.zip');
  noindex(q);
  const cdn = await request('/github.com/HITSZ-OpenAuto/repo/blob/main/file.txt', undefined, { USE_JSDELIVR: '1' });
  assert.equal(cdn.status, 302);
  assert.equal(cdn.headers.get('location'), 'https://cdn.jsdelivr.net/gh/HITSZ-OpenAuto/repo@main/file.txt');
  noindex(cdn);
});

test('valid downloads, upstream redirects and errors retain existing behavior', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('file contents', { headers: { 'content-type': 'application/octet-stream' } }));
  for (const path of [
    '/github.com/HITSZ-OpenAuto/repo/archive/main.zip',
    '/github.com/HITSZ-OpenAuto/repo/releases/download/v1/file.zip',
    '/github.com/HITSZ-OpenAuto/repo/blob/main/file.txt',
    '/raw.githubusercontent.com/HITSZ-OpenAuto/repo/main/file.txt',
    '/github.com/HITSZ-OpenAuto/repo/info/refs',
    '/github.com/HITSZ-OpenAuto/repo/tags',
    '/gist.githubusercontent.com/HITSZ-OpenAuto/id/raw/file.txt',
  ]) {
    const response = await request(path, { headers: { origin: 'https://hoa.moe' } });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'file contents');
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://hoa.moe');
    noindex(response);
  }
  assert.match(fetchMock.mock.calls[2].arguments[0], /\/raw\/main\/file.txt$/);
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://github.com/HITSZ-OpenAuto/repo/raw/main/file.txt' } }));
  const redirect = await request('/github.com/HITSZ-OpenAuto/repo/archive/main.zip');
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), '/https://github.com/HITSZ-OpenAuto/repo/raw/main/file.txt');
  for (const status of [403, 404, 500]) {
    fetchMock.mock.mockImplementation(async () => new Response('upstream error', { status }));
    const response = await request('/github.com/HITSZ-OpenAuto/repo/archive/main.zip');
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get('location'), 'https://fastdl.example').searchParams.get('code'), String(status));
    noindex(response);
  }
});

test('authorization rejection and preflight remain unchanged', async () => {
  const denied = await request('/github.com/another-owner/repo/archive/main.zip');
  assert.equal(denied.status, 302);
  assert.equal(new URL(denied.headers.get('location'), 'https://fastdl.example').searchParams.get('code'), '403');
  const preflight = await request('/github.com/HITSZ-OpenAuto/repo/archive/main.zip', { method: 'OPTIONS', headers: { 'access-control-request-headers': 'range' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'range');
  noindex(preflight);
});
