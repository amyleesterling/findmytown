const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
const PORT = 3458;

// Redfin city IDs for all 21 North Shore towns
const TOWN_IDS = {
  "Beverly": 1490, "Boxford": 36095, "Danvers": 36103, "Essex": 36111,
  "Gloucester": 6697, "Hamilton": 29750, "Ipswich": 36126, "Lynn": 9515,
  "Manchester-by-the-Sea": 29618, "Marblehead": 36132, "Middleton": 29803,
  "Nahant": 36139, "Newbury": 29796, "Newburyport": 11531, "Peabody": 13521,
  "Rockport": 36156, "Rowley": 36157, "Salem": 15302, "Swampscott": 36170,
  "Topsfield": 36171, "Wenham": 29567
};

// Cache: { listings: [...], photos: Map, lastFetch: timestamp }
let listingsCache = { listings: [], lastFetch: 0 };
const photoCache = new Map();
let isFetching = false;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ── Main listings endpoint ──
app.get('/api/listings', (req, res) => {
  // Always return immediately with whatever we have
  const enriched = listingsCache.listings.map(l => ({
    ...l,
    photoUrl: photoCache.get(String(l.id)) || l.photoUrl || null
  }));

  const maxAge = 60 * 60 * 1000; // 1 hour cache
  const stale = (Date.now() - listingsCache.lastFetch) > maxAge;

  res.json({
    listings: enriched,
    count: enriched.length,
    loading: isFetching,
    stale: stale && enriched.length === 0,
  });

  // Kick off background fetch if needed
  if (stale && !isFetching) {
    fetchAllListings();
  }
});

// ── Background fetch all listings ──
async function fetchAllListings() {
  if (isFetching) return;
  isFetching = true;
  try {
    const allListings = [];
    const townEntries = Object.entries(TOWN_IDS);
    for (let i = 0; i < townEntries.length; i += 5) {
      const batch = townEntries.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(([name, id]) => fetchTownListings(name, id))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') allListings.push(...r.value);
      }
      if (i + 5 < townEntries.length) await sleep(300);
    }
    listingsCache = { listings: allListings, lastFetch: Date.now() };
    console.log(`Fetched ${allListings.length} listings from ${townEntries.length} towns`);
    scrapePhotosInBackground(allListings);
  } catch (err) {
    console.error('Fetch error:', err.message);
  } finally {
    isFetching = false;
  }
}

// ── Cached photos endpoint (frontend polls this) ──
app.get('/api/photos', (req, res) => {
  const photos = {};
  for (const [id, url] of photoCache) photos[id] = url;
  res.json({ photos, count: photoCache.size });
});

// ── On-demand single photo fetch ──
app.get('/api/photo/:propertyId', async (req, res) => {
  const propId = req.params.propertyId;
  if (photoCache.has(propId)) return res.json({ photoUrl: photoCache.get(propId) });

  const redfinUrl = req.query.url;
  if (!redfinUrl) return res.json({ photoUrl: null });

  try {
    const html = await fetchUrl(redfinUrl);
    const ogMatch = html.match(/og:image[^>]*content="([^"]+)"/);
    const photoUrl = ogMatch ? ogMatch[1] : null;
    if (photoUrl) photoCache.set(propId, photoUrl);
    res.json({ photoUrl });
  } catch {
    res.json({ photoUrl: null });
  }
});

// ── Fetch listings for one town via Redfin GIS API ──
async function fetchTownListings(townName, regionId) {
  const params = new URLSearchParams({
    al: '1',
    num_homes: '100',
    ord: 'redfin-recommended-asc',
    page_number: '1',
    sf: '1,2,3,5,6,7',
    status: '9',
    uipt: '1,2,3,4,5,6,7,8',
    v: '8',
    min_listing_approx_size: '1600',
    min_num_beds: '3',
    min_num_baths: '1.5',
    min_lot_size: '10000',
    region_id: String(regionId),
    region_type: '6',
  });

  const url = `https://www.redfin.com/stingray/api/gis?${params.toString()}`;
  const data = await fetchUrl(url, { 'Referer': 'https://www.redfin.com/' });
  const jsonStr = data.replace(/^\{\}&&/, '');
  const parsed = JSON.parse(jsonStr);

  if (!parsed.payload?.homes) return [];

  return parsed.payload.homes
    .filter(h => h.latLong?.value?.latitude && h.latLong?.value?.longitude)
    .map(h => ({
      id: h.propertyId,
      mlsId: h.mlsId?.value,
      address: h.streetLine?.value || 'Unknown',
      city: h.city || townName,
      state: h.state || 'MA',
      zip: h.zip || h.postalCode?.value || '',
      lat: h.latLong.value.latitude,
      lon: h.latLong.value.longitude,
      price: h.price?.value || 0,
      priceFormatted: formatPrice(h.price?.value),
      beds: h.beds || 0,
      baths: h.baths || 0,
      sqft: h.sqFt?.value || 0,
      lotSqft: h.lotSize?.value || 0,
      redfinUrl: h.url ? `https://www.redfin.com${h.url}` : null,
      yearBuilt: h.yearBuilt?.value || null,
      status: h.mlsStatus || 'Active',
      townMatch: townName,
      photoUrl: null,
    }));
}

// ── Background photo scraper ──
async function scrapePhotosInBackground(listings) {
  const toScrape = listings.filter(l => l.redfinUrl && !photoCache.has(String(l.id)));
  console.log(`Scraping photos for ${toScrape.length} listings...`);

  for (let i = 0; i < toScrape.length; i += 3) {
    const batch = toScrape.slice(i, i + 3);
    await Promise.allSettled(batch.map(async (l) => {
      try {
        const html = await fetchUrl(l.redfinUrl);
        const ogMatch = html.match(/og:image[^>]*content="([^"]+)"/);
        if (ogMatch) photoCache.set(String(l.id), ogMatch[1]);
      } catch { /* skip */ }
    }));
    await sleep(600);
  }
  console.log(`Photo scraping done. ${photoCache.size} photos cached.`);
}

// ── Helpers ──
function formatPrice(amount) {
  if (!amount) return '$0';
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(2)}M`;
  return `$${(amount / 1000).toFixed(0)}K`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url.startsWith('http') ? url : `https://www.redfin.com${url}`);
    https.get({
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const loc = response.headers.location.startsWith('http')
          ? response.headers.location
          : `https://${parsedUrl.hostname}${response.headers.location}`;
        return fetchUrl(loc, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} for ${parsedUrl.pathname}`));
        } else {
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

app.listen(PORT, () => {
  console.log(`\n  FindMyTown Dashboard running at http://localhost:${PORT}\n`);
  console.log(`  Tracking ${Object.keys(TOWN_IDS).length} North Shore towns\n`);
  // Pre-fetch listings on startup
  fetchAllListings();
});
