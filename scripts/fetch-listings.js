#!/usr/bin/env node
// Fetches all Redfin listings and saves as static JSON for GitHub Pages
const https = require('https');
const fs = require('fs');
const path = require('path');

const TOWN_IDS = {
  "Beverly": 1490, "Boxford": 36095, "Danvers": 36103, "Essex": 36111,
  "Gloucester": 6697, "Hamilton": 29750, "Ipswich": 36126, "Lynn": 9515,
  "Manchester-by-the-Sea": 29618, "Marblehead": 36132, "Middleton": 29803,
  "Nahant": 36139, "Newbury": 29796, "Peabody": 13521,
  "Rockport": 36156, "Rowley": 36157, "Salem": 15302, "Swampscott": 36170,
  "Topsfield": 36171, "Wenham": 29567,
  "Billerica": 29563, "Wilmington": 36184, "Burlington": 36100, "Bedford": 29655,
  "Reading": 36155, "Wakefield": 36174, "Woburn": 20294, "Winchester": 36186,
  "Lexington": 36128, "Saugus": 36162, "Melrose": 10229, "Malden": 9614,
  "Medford": 10142, "North Reading": 29768,
  "Arlington": 36088, "Concord": 29674, "Somerville": 16064, "Stoneham": 36168, "Lynnfield": 36131
};

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
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
        if (response.statusCode !== 200) reject(new Error(`HTTP ${response.statusCode}`));
        else resolve(data);
      });
    }).on('error', reject);
  });
}

function formatPrice(amount) {
  if (!amount) return '$0';
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(2)}M`;
  return `$${(amount / 1000).toFixed(0)}K`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchTownListings(townName, regionId) {
  const params = new URLSearchParams({
    al: '1', num_homes: '100', ord: 'redfin-recommended-asc',
    page_number: '1', sf: '1,2,3,5,6,7', status: '9',
    uipt: '1', v: '8',
    min_listing_approx_size: '1600', min_num_beds: '3', min_num_baths: '1.5',
    min_lot_size: '10000',
    region_id: String(regionId), region_type: '6',
  });

  const url = `https://www.redfin.com/stingray/api/gis?${params.toString()}`;
  const data = await fetchUrl(url, { 'Referer': 'https://www.redfin.com/' });
  const jsonStr = data.replace(/^\{\}&&/, '');
  const parsed = JSON.parse(jsonStr);

  if (!parsed.payload?.homes) return [];

  return parsed.payload.homes
    .filter(h => h.latLong?.value?.latitude && h.latLong?.value?.longitude)
    .filter(h => h.uiPropertyType === 1) // Single-family only (excludes condos/townhouses)
    .filter(h => h.price?.value >= 650000 && h.price.value <= 1100000)
    .map(h => ({
      id: h.propertyId,
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
      timeOnRedfin: h.timeOnRedfin?.value || null, // milliseconds
      townMatch: townName,
      photoUrl: buildPhotoUrl(h),
      description: h.listingRemarks || '',
    }));
}

// Redfin blocks listing-page fetches from CI IPs, so og:image scraping is dead.
// The CDN URL is constructible from GIS API fields instead:
// photo/{dataSourceId}/mbpaddedwide/{last 3 of MLS#}/genMid.{MLS#}_0.jpg
function buildPhotoUrl(h) {
  const mls = h.mlsId?.value;
  if (!mls || h.dataSourceId == null || h.numPictures === 0) return null;
  return `https://ssl.cdn-redfin.com/photo/${h.dataSourceId}/mbpaddedwide/${String(mls).slice(-3)}/genMid.${mls}_0.jpg`;
}

// Archive every home's list price in listing-history.json so fetch-sold.js can
// show sale price vs list price after the home sells and leaves the live feed.
// Seed/rebuild the archive with scripts/build-listing-history.js.
function historyKey(address, city) {
  return `${address}|${city}`.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function updateListingHistory(listings) {
  const historyPath = path.join(__dirname, '..', 'listing-history.json');
  let history = { homes: {} };
  try {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (!history.homes) history.homes = {};
  } catch (e) { /* first run: start fresh */ }

  const today = new Date().toISOString().slice(0, 10);
  for (const l of listings) {
    if (!l.address || !l.price) continue;
    const key = historyKey(l.address, l.city || '');
    const existing = history.homes[key];
    if (!existing) {
      history.homes[key] = {
        id: l.id,
        address: l.address,
        city: l.city,
        listPrice: l.price,
        origListPrice: l.price,
        firstSeen: today,
        lastSeen: today,
        priceHistory: [{ date: today, price: l.price, event: 'Listed' }],
        photoUrl: l.photoUrl || null,
        redfinUrl: l.redfinUrl || null,
      };
    } else {
      if (!existing.priceHistory) existing.priceHistory = [{ date: existing.firstSeen, price: existing.origListPrice, event: 'Listed' }];
      if (l.price !== existing.listPrice) {
        existing.priceHistory.push({ date: today, price: l.price, event: 'Price Changed' });
      }
      existing.listPrice = l.price;
      existing.lastSeen = today;
      if (l.photoUrl) existing.photoUrl = l.photoUrl;
      if (l.redfinUrl) existing.redfinUrl = l.redfinUrl;
    }
  }

  history.count = Object.keys(history.homes).length;
  history.updatedAt = new Date().toISOString();
  fs.writeFileSync(historyPath, JSON.stringify(history));
  console.log(`Listing history: ${history.count} homes archived`);
}

async function main() {
  console.log(`Fetching listings from ${Object.keys(TOWN_IDS).length} towns...`);
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

  console.log(`Fetched ${allListings.length} listings total`);

  const withPhotos = allListings.filter(l => l.photoUrl).length;
  console.log(`Got photos for ${withPhotos}/${allListings.length} listings`);

  updateListingHistory(allListings);

  // Save to public directory
  const output = {
    listings: allListings,
    count: allListings.length,
    fetchedAt: new Date().toISOString(),
  };

  const json = JSON.stringify(output);
  // Save to both public/ (for local dev) and root (for GitHub Pages)
  const publicPath = path.join(__dirname, '..', 'public', 'listings.json');
  const rootPath = path.join(__dirname, '..', 'listings.json');
  fs.writeFileSync(publicPath, json);
  fs.writeFileSync(rootPath, json);
  console.log(`Saved to ${rootPath} (${(json.length / 1024).toFixed(0)} KB)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
