// Mocks global.fetch to verify fetchHtml() correctly decodes non-UTF-8
// responses. Swedish å/ä/ö characters are all within Latin-1's range, so
// Buffer.from(str, 'latin1') round-trips them as real Latin-1/Windows-1252
// bytes for this test.

function toArrayBuffer(str, encoding) {
  const buf = Buffer.from(str, encoding);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function mockFetchOnce({ body, contentTypeHeader }) {
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentTypeHeader : null) },
    arrayBuffer: async () => toArrayBuffer(body, 'latin1'),
  });
}

function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) {
    console.log(`  expected: ${JSON.stringify(expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual)}`);
  }
  return ok;
}

async function run() {
  const { fetchHtml } = require('../scrape.js');
  const sample = '<html><body>fre 7 aug lör 8 aug sön 9 aug</body></html>';
  let allPassed = true;

  // 1. Content-Type header declares iso-8859-1
  mockFetchOnce({ body: sample, contentTypeHeader: 'text/html; charset=iso-8859-1' });
  const decoded1 = await fetchHtml('https://example.test');
  allPassed &= check('decodes iso-8859-1 header correctly', decoded1, sample);

  // 2. Content-Type header declares windows-1252
  mockFetchOnce({ body: sample, contentTypeHeader: 'text/html; charset=windows-1252' });
  const decoded2 = await fetchHtml('https://example.test');
  allPassed &= check('decodes windows-1252 header correctly', decoded2, sample);

  // 3. No header, but a <meta charset> tag in the body
  const sampleWithMeta = `<html><head><meta charset="iso-8859-1"></head><body>${sample}</body></html>`;
  mockFetchOnce({ body: sampleWithMeta, contentTypeHeader: '' });
  const decoded3 = await fetchHtml('https://example.test');
  allPassed &= check('decodes via <meta charset> fallback', decoded3, sampleWithMeta);

  // 4. Plain UTF-8, no charset info at all — should still work
  const utf8Sample = sample;
  global.fetch = async () => ({
    ok: true, status: 200, statusText: 'OK',
    headers: { get: () => null },
    arrayBuffer: async () => toArrayBuffer(utf8Sample, 'utf-8'),
  });
  const decoded4 = await fetchHtml('https://example.test');
  allPassed &= check('defaults to utf-8 with no charset info', decoded4, utf8Sample);

  process.exit(allPassed ? 0 : 1);
}

run();
