const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { createEvents } = require('ics');
const { flatten, parseSchedule, extractFilmDetails, applyFilmDetails } = require('../scrape.js');

const scheduleHtml = fs.readFileSync('test/fixture.html', 'utf8');
const filmHtml = fs.readFileSync('test/film-fixture.html', 'utf8');

const $ = cheerio.load(scheduleHtml);
const flat = flatten($, $('body').get(0));
const events = parseSchedule(flat, new Date(2026, 7, 5));
console.log(`Parsed ${events.length} schedule events`);

// Mock: every film url resolves to the same film-fixture (good enough for pipeline test)
const detailsByUrl = new Map();
for (const e of events) {
  if (e.url) {
    const $$ = cheerio.load(filmHtml);
    detailsByUrl.set(e.url, extractFilmDetails($$));
  }
}
applyFilmDetails(events, detailsByUrl);

const { error, value } = createEvents(events, { calName: 'Test', productId: 'test' });
if (error) { console.error(error); process.exit(1); }
console.log('\n--- Sample VEVENT ---');
console.log(value.split('BEGIN:VEVENT')[1].split('END:VEVENT')[0]);
