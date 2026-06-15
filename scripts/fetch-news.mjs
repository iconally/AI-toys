// Fetches latest English-language AI-toy news + incidents from Google News RSS,
// merges new items into data/news.json and data/incidents.json (dedup by URL/headline),
// and caps each list. Runs in GitHub Actions (Node 20+, global fetch). No dependencies.
import { readFile, writeFile } from 'node:fs/promises';

const NEWS_RSS =
  'https://news.google.com/rss/search?q=' +
  encodeURIComponent('("AI toy" OR "AI toys" OR "AI-powered toy") when:14d') +
  '&hl=en-US&gl=US&ceid=US:en';

const INCIDENT_RSS =
  'https://news.google.com/rss/search?q=' +
  encodeURIComponent('("AI toy" OR "AI toys") (recall OR hacked OR hack OR breach OR privacy OR lawsuit OR banned OR investigation OR dangerous) when:30d') +
  '&hl=en-US&gl=US&ceid=US:en';

const NEWS_FILE = 'data/news.json';
const INCIDENT_FILE = 'data/incidents.json';
const NEWS_CAP = 12;
const INCIDENT_CAP = 10;

function decode(s) {
  if (!s) return '';
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(rx, block) {
  const m = block.match(rx);
  return m ? m[1] : '';
}

function relativeDate(pubDate) {
  const d = new Date(pubDate);
  if (isNaN(d)) return '';
  const diff = Date.now() - d.getTime();
  const day = 86400000;
  if (diff < day) return 'today';
  if (diff < 2 * day) return '1 day ago';
  if (diff < 7 * day) return Math.round(diff / day) + ' days ago';
  if (diff < 14 * day) return '1 week ago';
  return Math.round(diff / (7 * day)) + ' weeks ago';
}

async function fetchItems(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'AIToySafetyBot/1.0' } });
  if (!res.ok) throw new Error('RSS fetch failed: ' + res.status);
  const xml = await res.text();
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const rawTitle = decode(tag(/<title>([\s\S]*?)<\/title>/, block));
    const link = decode(tag(/<link>([\s\S]*?)<\/link>/, block));
    const pubDate = tag(/<pubDate>([\s\S]*?)<\/pubDate>/, block);
    let source = decode(tag(/<source[^>]*>([\s\S]*?)<\/source>/, block));
    const description = decode(tag(/<description>([\s\S]*?)<\/description>/, block));
    let headline = rawTitle;
    // Google News titles are usually "Headline - Source"
    if (!source && rawTitle.includes(' - ')) {
      const idx = rawTitle.lastIndexOf(' - ');
      headline = rawTitle.slice(0, idx).trim();
      source = rawTitle.slice(idx + 3).trim();
    } else if (source && headline.endsWith(' - ' + source)) {
      headline = headline.slice(0, headline.length - (3 + source.length)).trim();
    }
    if (!headline || !link) continue;
    items.push({ headline, source: source || 'News', url: link, date: relativeDate(pubDate), pub: pubDate, description });
  }
  return items;
}

function classifyTag(text) {
  const t = text.toLowerCase();
  if (/recall|pulled|withdrawn|banned/.test(t)) return ['recall', 'Recall'];
  if (/privacy|data|breach|hack|surveil|record/.test(t)) return ['privacy', 'Privacy'];
  if (/study|research|report|finds|professor|university/.test(t)) return ['research', 'Research'];
  return ['', 'Industry'];
}

function severityFor(text) {
  const t = text.toLowerCase();
  if (/recall|ban|lawsuit|breach|hack|explicit|sexual|danger|withdrawn/.test(t)) return 'high';
  return 'medium';
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return []; }
}

function summarize(s, max = 220) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1).trim() + '…' : s;
}

async function run() {
  const existingNews = await readJson(NEWS_FILE);
  const existingInc = await readJson(INCIDENT_FILE);

  // --- News ---
  let news = [];
  try {
    const raw = await fetchItems(NEWS_RSS);
    const seen = new Set(existingNews.map(n => norm(n.headline)));
    const fresh = [];
    for (const it of raw) {
      const key = norm(it.headline);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const [tg, tgLabel] = classifyTag(it.headline + ' ' + it.description);
      fresh.push({
        source: it.source,
        date: it.date,
        tag: tg,
        tagLabel: tgLabel,
        headline: it.headline,
        summary: summarize(it.description) || it.headline,
        url: it.url,
      });
    }
    news = [...fresh, ...existingNews].slice(0, NEWS_CAP);
  } catch (e) {
    console.error('News fetch error:', e.message);
    news = existingNews;
  }

  // --- Incidents ---
  let incidents = [];
  try {
    const raw = await fetchItems(INCIDENT_RSS);
    const seen = new Set(existingInc.map(i => norm(i.title)));
    const fresh = [];
    for (const it of raw) {
      const key = norm(it.headline);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      fresh.push({
        severity: severityFor(it.headline + ' ' + it.description),
        toy: '',
        title: it.headline,
        desc: summarize(it.description, 180) || ('Reported by ' + it.source + '.'),
        url: it.url,
      });
    }
    incidents = [...fresh, ...existingInc].slice(0, INCIDENT_CAP);
  } catch (e) {
    console.error('Incident fetch error:', e.message);
    incidents = existingInc;
  }

  await writeFile(NEWS_FILE, JSON.stringify(news, null, 2) + '\n');
  await writeFile(INCIDENT_FILE, JSON.stringify(incidents, null, 2) + '\n');
  console.log(`Wrote ${news.length} news items, ${incidents.length} incidents.`);
}

run().catch(e => { console.error(e); process.exit(1); });
