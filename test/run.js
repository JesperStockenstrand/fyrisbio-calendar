const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { flatten, parseSchedule } = require('../scrape.js');

const html = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const $ = cheerio.load(html);
const flat = flatten($, $('body').get(0));

console.log('--- flattened text (first 500 chars) ---');
console.log(flat.slice(0, 500));

const today = new Date(2026, 7, 5); // 5 aug 2026, matches "current date" in the conversation
const events = parseSchedule(flat, today);

console.log(`\n--- parsed ${events.length} events ---`);
for (const e of events) {
  console.log(e.start.join('-'), '|', e.title, '|', e.location, '|', e.description || '', '|', e.url);
}
