# Fyrisbiografen calendar feed

Scrapes [fyrisbiografen.se's kalendarium](https://fyrisbiografen.se/index.php?p=kalendarium)
every 6 hours and publishes a subscribable `.ics` calendar feed via GitHub Pages —
no server to run or maintain.

## Setup (one-time)

1. Create a new **public** GitHub repository and push these files to it.
   (Public is required for the free GitHub Pages tier to serve the file.)
2. In the repo, go to **Settings → Pages**.
   - Source: **Deploy from a branch**
   - Branch: `main`, folder: `/docs`
   - Save.
3. Wait a minute, then GitHub will show you the Pages URL, something like:
   `https://<your-username>.github.io/<repo-name>/`
4. The calendar feed will be at:
   `https://<your-username>.github.io/<repo-name>/fyrisbiografen.ics`
5. Trigger the first run manually so the file exists immediately: go to the
   **Actions** tab → "Update Fyrisbiografen calendar" → **Run workflow**.
   After that it updates itself every 6 hours automatically.

## Subscribing

In most calendar apps, use "Add calendar → From URL" / "Subscribe":

- **Google Calendar** (web): Other calendars → + → From URL → paste the `https://...ics` URL.
- **Apple Calendar / iOS**: Settings → Calendar → Accounts → Add Account →
  Other → Add Subscribed Calendar → paste the URL (you can use `webcal://`
  instead of `https://` here and it'll open directly).
- **Outlook**: Add calendar → Subscribe from web → paste the URL.

## How it works

- `scrape.js` fetches the kalendarium page, flattens the HTML into an ordered
  text stream (keeping ticket links inline), and pattern-matches on the
  visible structure: a date header (`fre 7 aug`, `i dag`, `i morgon`) followed
  by showtimes (`17:30 · Title · (Salong 1)`).
- For each distinct film found, it then visits that film's own page once
  (politely — one request at a time, with a short delay between them) and
  extracts:
  - a synopsis (found by locating the metadata table — Land/Produktionsår/
    Längd/Genre/etc. — and taking the first real prose that follows it)
  - the cast list, if a "Medverkande:" line is present
  - the actual runtime in minutes, used as the event's duration instead of a
    fixed placeholder
- Each calendar entry's description combines the note (e.g. "Premiär"), the
  synopsis, and the cast list.
- Each event gets a stable ID derived from date+time+title, so repeated runs
  update existing calendar entries rather than duplicating them.
- Showtimes are converted from Stockholm local time to UTC correctly across
  the CET/CEST daylight-saving boundary.
- `.github/workflows/update.yml` runs the scraper on a schedule and commits
  the resulting `docs/fyrisbiografen.ics` if it changed.

## Known limitations

- **Neither parser is tied to specific CSS classes** — I couldn't inspect the
  page's raw HTML/class names ahead of time (only its rendered text), so
  both the schedule parser and the film-detail parser work by pattern-matching
  the visible structure rather than exact selectors. This is fairly resilient
  to small markup tweaks, but if fyrisbiografen.se changes its layout
  significantly, the Action may start failing (it intentionally throws rather
  than publishing an empty calendar) — check the Actions tab logs.
  `parseSchedule()` and `extractFilmDetails()` in `scrape.js` are the places
  to adjust. If it fails, `scrape.js` prints diagnostics (raw HTML length,
  whether key markers like "Kalendarium" or "Salong" are present, and a
  snippet of the flattened text) directly to the Action's log — check there
  first before changing any code.
- **Character encoding**: the page's actual byte encoding might not be
  UTF-8 (some Swedish sites serve ISO-8859-1/Windows-1252), which would
  silently corrupt å/ä/ö and break every date match. `fetchHtml()` detects
  the real charset from the response headers or a `<meta charset>` tag and
  decodes accordingly, rather than assuming UTF-8.
- **If a film's runtime can't be found**, its event falls back to a 2-hour
  placeholder duration (`DEFAULT_DURATION_HOURS`).
- **If a film page fails to fetch or parse**, that event just keeps its
  existing note (e.g. "Premiär") as the description, with no synopsis — the
  whole run doesn't fail because of one bad film page.
- Fetching per-film pages means each run makes roughly one request per
  distinct film currently showing (typically a couple dozen), spaced ~400ms
  apart — still well within a single Action run.
- Times are output as UTC instants (correct in absolute terms), which is the
  standard way subscribed calendars are meant to work — your calendar app
  will display them in your local timezone.

## Local testing

```
npm install
node scrape.js              # writes docs/fyrisbiografen.ics (hits the live site)
npm test                     # runs all parser tests against saved fixtures, no network needed
```
