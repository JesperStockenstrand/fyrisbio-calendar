// Scrapes Fyrisbiografen's kalendarium page and generates a subscribable
// ICS calendar feed (docs/fyrisbiografen.ics), served via GitHub Pages.
//
// NOTE ON ROBUSTNESS: this doesn't rely on specific CSS classes/ids, because
// those weren't inspectable ahead of time. Instead it flattens the page's
// text (keeping links inline) and pattern-matches on the visible structure:
// a date header ("fre 7 aug", "i dag", "i morgon"), followed by one or more
// showtimes ("17:30  Title  (Salong 1)"). If fyrisbiografen.se changes its
// layout, this is the file to revisit — the parsing logic is isolated in
// parseSchedule() below.

const cheerio = require('cheerio');
const { createEvents } = require('ics');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAGE_URL = 'https://fyrisbiografen.se/index.php?p=kalendarium';
const OUTPUT_PATH = path.join(__dirname, 'docs', 'fyrisbiografen.ics');
const DEFAULT_DURATION_HOURS = 2; // fallback if a film's runtime can't be found
const FILM_FETCH_DELAY_MS = 400; // be polite to a small site — fetch film pages one at a time

// Known field labels from this Kinoplex-template metadata table (Land,
// Produktionsår, Premiär, Längd, Genre, Åldersgräns, Distributör, Språk,
// Textning). Used as anchors to locate the synopsis text that follows the
// table — checked in this order since later labels are less likely to also
// appear as stray text elsewhere on the page.
const METADATA_LABEL_PRIORITY = [
  'Textning', 'Språk', 'Distributör', 'Åldersgräns', 'Genre', 'Längd', 'Premiär', 'Produktionsår', 'Land',
];

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

const WEEKDAYS = ['mån', 'tis', 'ons', 'tors', 'fre', 'lör', 'sön'];

// The `ics` package stamps the given [y,m,d,h,mi] array as literal UTC with no
// conversion, so Stockholm local wall-clock times need to be converted to UTC
// ourselves (accounting for CET/CEST) before being passed in.
function stockholmLocalToUtcParts(y, m, d, h, mi) {
  // Use midday as the offset probe to sidestep the DST-transition edge case
  // (transitions happen at 2-3am local time, never at noon).
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0));
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const parts = fmt.formatToParts(probe).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const localAsUtcMillis = Date.UTC(
    parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10),
    parseInt(parts.hour, 10) === 24 ? 0 : parseInt(parts.hour, 10), parseInt(parts.minute, 10)
  );
  const offsetMinutes = Math.round((localAsUtcMillis - probe.getTime()) / 60000);

  const utcMillis = Date.UTC(y, m - 1, d, h, mi) - offsetMinutes * 60000;
  const utcDate = new Date(utcMillis);
  return [
    utcDate.getUTCFullYear(),
    utcDate.getUTCMonth() + 1,
    utcDate.getUTCDate(),
    utcDate.getUTCHours(),
    utcDate.getUTCMinutes(),
  ];
}

// --- 1. Fetch -----------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Decode the response using whatever charset it actually declares (or falls
// back to sniffing a <meta charset> / <meta http-equiv content-type> tag in
// the bytes). Swedish sites sometimes serve ISO-8859-1 or Windows-1252 even
// when nothing about the request suggests it — if we blindly assumed UTF-8,
// every å/ä/ö in weekday names ("mån", "lör", "sön") would come out mangled
// and silently break every date-matching regex, which looks exactly like
// "parsed zero events" with no other symptom.
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FyrisCalendarBot/1.0; +personal-use)' },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());

  let charset = null;
  const headerMatch = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i);
  if (headerMatch) charset = headerMatch[1].toLowerCase();

  if (!charset) {
    // Only need to look at the first few hundred bytes as plain ASCII to find a meta tag.
    const head = buffer.slice(0, 2048).toString('latin1');
    const metaMatch = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
    if (metaMatch) charset = metaMatch[1].toLowerCase();
  }

  charset = charset || 'utf-8';
  // Node's TextDecoder doesn't recognize "iso-8859-1" as an alias in all builds; normalize the common ones.
  const normalized = charset === 'iso-8859-1' || charset === 'latin1' ? 'windows-1252' : charset;

  try {
    return new TextDecoder(normalized).decode(buffer);
  } catch (err) {
    console.warn(`Unrecognized charset "${charset}", falling back to utf-8: ${err.message}`);
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// Prints a few cheap, high-signal checks so a "parsed zero events" failure
// is diagnosable from the Action log alone, without needing to reproduce it.
function logDiagnostics(html, flatText) {
  console.log(`--- diagnostics ---`);
  console.log(`Raw HTML length: ${html.length} chars`);
  console.log(`Flattened text length: ${flatText.length} chars`);
  const markers = ['Kalendarium', 'Salong', 'i dag', 'i morgon', 'fre', 'lör', 'sön', 'aug'];
  for (const marker of markers) {
    console.log(`  contains "${marker}": ${flatText.includes(marker)}`);
  }
  console.log(`First 2000 chars of flattened text:\n${flatText.slice(0, 2000)}`);
  console.log(`---`);
  console.log(`Last 1000 chars of flattened text:\n${flatText.slice(-1000)}`);
  console.log(`--- end diagnostics ---`);
}

// --- 2. Flatten DOM into an ordered text stream, keeping link hrefs -----

function flatten($, node) {
  let out = '';
  $(node)
    .contents()
    .each((_, el) => {
      if (el.type === 'text') {
        out += el.data;
      } else if (el.type === 'tag') {
        if (el.name === 'script' || el.name === 'style' || el.name === 'noscript') {
          return;
        }
        if (el.name === 'a') {
          const href = $(el).attr('href') || '';
          const text = $(el).text();
          out += ` [[LINK|${href}]]${text}[[/LINK]] `;
        } else {
          out += flatten($, el);
        }
        if (['div', 'p', 'li', 'tr', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'table'].includes(el.name)) {
          out += '\n';
        }
      }
    });
  return out;
}

// --- 3. Date resolution ---------------------------------------------------

function resolveDate(marker, today) {
  const m = marker.trim().toLowerCase();

  if (m === 'i dag') return new Date(today);
  if (m === 'i morgon') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return d;
  }

  const match = m.match(new RegExp(`(${WEEKDAYS.join('|')})\\s+(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})`));
  if (!match) return null;

  const day = parseInt(match[2], 10);
  const month = MONTHS[match[3]];
  let year = today.getFullYear();

  let candidate = new Date(year, month, day);
  // If the date lands more than a few days in the past, it must be next year
  // (handles the Dec -> Jan rollover while the page still shows a "past" month name).
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 3);
  if (candidate < cutoff) {
    candidate = new Date(year + 1, month, day);
  }
  return candidate;
}

// --- 4. Parse the flattened text into events -----------------------------

function parseSchedule(flatText, today) {
  const dateMarkerRe = new RegExp(
    `(i dag|i morgon|(?:${WEEKDAYS.join('|')})\\s+\\d{1,2}\\s+(?:${Object.keys(MONTHS).join('|')}))`,
    'gi'
  );
  const timeEntryRe = /(\d{1,2}):(\d{2})\s*(?:\[\[LINK\|([^\]]*)\]\]([^[]*)\[\[\/LINK\]\])?\s*([^([\n]*)?\(Salong\s*(\d+)\)/gi;

  // Split the text into chunks, each starting at a date marker.
  const markers = [...flatText.matchAll(dateMarkerRe)];
  const chunks = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index;
    const end = i + 1 < markers.length ? markers[i + 1].index : flatText.length;
    chunks.push({ marker: markers[i][0], text: flatText.slice(start, end) });
  }

  const events = [];
  const seen = new Set();

  for (const chunk of chunks) {
    const date = resolveDate(chunk.marker, today);
    if (!date) continue;

    let m;
    timeEntryRe.lastIndex = 0;
    while ((m = timeEntryRe.exec(chunk.text)) !== null) {
      const hour = parseInt(m[1], 10);
      const minute = parseInt(m[2], 10);
      const href = (m[3] || '').trim();
      const title = (m[4] || '').replace(/\s+/g, ' ').trim();
      const note = (m[5] || '').replace(/\s+/g, ' ').trim();
      const salong = m[6];

      if (!title) continue;

      const key = `${date.toISOString().slice(0, 10)}|${hour}:${minute}|${title}`;
      if (seen.has(key)) continue; // page repeats the same block more than once
      seen.add(key);

      events.push({
        title,
        start: stockholmLocalToUtcParts(date.getFullYear(), date.getMonth() + 1, date.getDate(), hour, minute),
        startInputType: 'utc',
        duration: { hours: DEFAULT_DURATION_HOURS },
        location: `Fyrisbiografen, Salong ${salong}`,
        note: note || '', // e.g. "Premiär" — kept separate so it can be combined with the synopsis below
        description: note || undefined,
        url: href ? new URL(href, PAGE_URL).toString() : undefined,
        uid: crypto.createHash('md5').update(key).digest('hex') + '@fyrisbio-calendar',
      });
    }
  }

  return events;
}

// --- 4b. Fetch each film's own page for a synopsis + runtime -------------

// This site (Kinoplex CMS) renders each film page with a metadata table
// (Land / Produktionsår / Premiär / Längd / Genre / Åldersgräns / Distributör /
// Språk / Textning) followed by a synopsis paragraph, then optionally a
// "Medverkande:" (cast) line. There's no unique class/id available to target,
// so — same approach as the schedule parser — this flattens the page to text
// and locates the synopsis by its position relative to the metadata table.
function stripLinkMarkers(text) {
  return text.replace(/\[\[LINK\|[^\]]*\]\]/g, '').replace(/\[\[\/LINK\]\]/g, '');
}

function extractFilmDetails($) {
  const flat = stripLinkMarkers(flatten($, $('body').get(0)));

  const runtimeMatch = flat.match(/\b(\d{2,3})\s*min\b/);
  const runtimeMinutes = runtimeMatch ? parseInt(runtimeMatch[1], 10) : null;

  let anchorIdx = -1;
  for (const label of METADATA_LABEL_PRIORITY) {
    const idx = flat.indexOf(label);
    if (idx !== -1) {
      anchorIdx = idx;
      break;
    }
  }

  let synopsis = '';
  let cast = '';

  if (anchorIdx !== -1) {
    const after = flat.slice(anchorIdx);
    const endMatch = after.match(/Medverkande\s*:?|Skriv ut information/i);
    const beforeEnd = endMatch ? after.slice(0, endMatch.index) : after.slice(0, 1500);

    // The metadata table's labels and values are short, standalone lines
    // (country names, years, "111 min", genre words, etc.) with no
    // sentence-ending punctuation. The synopsis is the first real prose we
    // hit after the anchor — a line long enough, or punctuated enough, to
    // read as a sentence rather than a table cell.
    const lines = beforeEnd.split('\n').map((l) => l.trim()).filter(Boolean);
    let startLine = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isKnownLabel = METADATA_LABEL_PRIORITY.includes(line);
      const looksLikeProse = !isKnownLabel && (line.length >= 35 || /[a-zåäö]{3,}[^.]*\./.test(line));
      if (looksLikeProse) {
        startLine = i;
        break;
      }
    }
    synopsis = cleanParagraph(lines.slice(startLine).join('\n'));

    if (endMatch && /Medverkande/i.test(endMatch[0])) {
      const afterCast = after.slice(endMatch.index + endMatch[0].length);
      const castEndMatch = afterCast.match(/Skriv ut information/i);
      const castRaw = castEndMatch ? afterCast.slice(0, castEndMatch.index) : afterCast.slice(0, 300);
      cast = cleanParagraph(castRaw);
    }
  }

  return { synopsis, cast, runtimeMinutes };
}

function cleanParagraph(text) {
  return stripLinkMarkers(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function fetchAllFilmDetails(events) {
  const uniqueUrls = [...new Set(events.map((e) => e.url).filter(Boolean))];
  const detailsByUrl = new Map();

  for (const url of uniqueUrls) {
    try {
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);
      detailsByUrl.set(url, extractFilmDetails($));
    } catch (err) {
      console.warn(`Could not fetch/parse film page ${url}: ${err.message}`);
      detailsByUrl.set(url, { synopsis: '', cast: '', runtimeMinutes: null });
    }
    await sleep(FILM_FETCH_DELAY_MS);
  }

  return detailsByUrl;
}

function applyFilmDetails(events, detailsByUrl) {
  for (const event of events) {
    const details = event.url ? detailsByUrl.get(event.url) : null;
    if (!details) {
      delete event.note;
      continue;
    }

    const parts = [];
    if (event.note) parts.push(event.note);
    if (details.synopsis) parts.push(details.synopsis);
    if (details.cast) parts.push(`Medverkande: ${details.cast}`);
    event.description = parts.join('\n\n') || undefined;

    if (details.runtimeMinutes) {
      event.duration = { minutes: details.runtimeMinutes };
    }
    delete event.note;
  }
}

// --- 5. Main ---------------------------------------------------------------

async function main() {
  const html = await fetchHtml(PAGE_URL);
  const $ = cheerio.load(html);
  const flatText = flatten($, $('body').get(0));

  const today = new Date();
  const events = parseSchedule(flatText, today);

  if (events.length === 0) {
    logDiagnostics(html, flatText);
    throw new Error('Parsed zero events — the page layout may have changed. Not overwriting the existing feed.');
  }

  const detailsByUrl = await fetchAllFilmDetails(events);
  applyFilmDetails(events, detailsByUrl);

  const { error, value } = createEvents(events, {
    calName: 'Fyrisbiografen',
    productId: 'fyrisbio-calendar',
  });

  if (error) {
    throw error;
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, value);
  console.log(`Wrote ${events.length} events to ${OUTPUT_PATH}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  flatten, resolveDate, parseSchedule, extractFilmDetails, applyFilmDetails, cleanParagraph, stripLinkMarkers,
  fetchHtml,
};
