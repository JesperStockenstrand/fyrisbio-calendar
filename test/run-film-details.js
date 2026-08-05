const fs = require('fs');
const cheerio = require('cheerio');
const { extractFilmDetails } = require('../scrape.js');

function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${name}`);
  if (!ok) {
    console.log(`  expected: ${expected}`);
    console.log(`  actual:   ${actual}`);
  }
  return ok;
}

let allPassed = true;

// Case 1: real film page structure (from an actual fetched page)
const filmHtml = fs.readFileSync('test/film-fixture.html', 'utf8');
const d1 = extractFilmDetails(cheerio.load(filmHtml));
allPassed &= check('runtime extracted', d1.runtimeMinutes, 111);
allPassed &= check(
  'synopsis starts correctly (no metadata leakage)',
  d1.synopsis.startsWith('Clark (Chiwetel Ejiofor)'),
  true
);
allPassed &= check('cast has no stray link markers', d1.cast.includes('[[LINK'), false);
allPassed &= check('cast extracted', d1.cast, 'Renate Reinsve, och Chiwetel Ejiofor.');

// Case 2: no "Medverkande" cast line present
const html2 =
  '<div>Genre<br>Längd<br></div><div>Dokumentär<br>90 min<br></div>' +
  '<p>En dokumentär om något viktigt som händer i världen just nu och som alla borde bry sig om.</p>' +
  '<a href="x">Skriv ut information om filmen</a>';
const d2 = extractFilmDetails(cheerio.load(html2));
allPassed &= check('no-cast case: runtime', d2.runtimeMinutes, 90);
allPassed &= check('no-cast case: cast is empty', d2.cast, '');
allPassed &= check(
  'no-cast case: synopsis found',
  d2.synopsis.startsWith('En dokumentär'),
  true
);

// Case 3: no metadata table at all — should degrade gracefully, not throw
const html3 = '<p>Some page with no recognizable metadata table structure at all.</p>';
const d3 = extractFilmDetails(cheerio.load(html3));
allPassed &= check('no-anchor case: synopsis empty', d3.synopsis, '');
allPassed &= check('no-anchor case: runtime null', d3.runtimeMinutes, null);

process.exit(allPassed ? 0 : 1);
