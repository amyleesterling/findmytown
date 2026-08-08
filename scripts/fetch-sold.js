#!/usr/bin/env node
// Fetches recently sold homes from Redfin's stingray GIS-CSV API and saves as static JSON.
// The JSON GIS endpoint doesn't return sold data properly, but the CSV endpoint does
// when using the sold_within_days parameter.
const https = require('https');
const http = require('http');
const tls = require('tls');
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
  "Arlington": 36088, "Concord": 29674, "Somerville": 16064, "Stoneham": 36168, "Lynnfield": 36131,
  "Amesbury": 29733
};

// Honors HTTPS_PROXY (needed in sandboxed dev environments); connects
// directly when unset, as on GitHub Actions runners.
function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      }
    };
    const handleResponse = (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        const loc = response.headers.location.startsWith('http')
          ? response.headers.location
          : `https://${parsedUrl.hostname}${response.headers.location}`;
        return fetchUrl(loc, extraHeaders).then(resolve).catch(reject);
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new Error(`HTTP ${response.statusCode}: ${data.substring(0, 200)}`));
        else resolve(data);
      });
    };

    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!proxy) {
      https.get(options, handleResponse).on('error', reject);
      return;
    }
    const proxyUrl = new URL(proxy);
    const connectReq = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || 80,
      method: 'CONNECT',
      path: `${parsedUrl.hostname}:443`,
      headers: { Host: `${parsedUrl.hostname}:443` },
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      https.get({
        ...options,
        createConnection: () => tls.connect({ socket, servername: parsedUrl.hostname }),
      }, handleResponse).on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.end();
  });
}

function formatPrice(amount) {
  if (!amount) return '$0';
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(2)}M`;
  return `$${(amount / 1000).toFixed(0)}K`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Parse CSV row handling quoted fields
function parseCSVRow(row) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

// Parse sold date like "February-17-2026" to "2026-02-17"
function parseSoldDate(dateStr) {
  if (!dateStr) return null;
  const months = {
    January: '01', February: '02', March: '03', April: '04',
    May: '05', June: '06', July: '07', August: '08',
    September: '09', October: '10', November: '11', December: '12'
  };
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  const month = months[parts[0]];
  if (!month) return null;
  return `${parts[2]}-${month}-${parts[1].padStart(2, '0')}`;
}

// Same key format as fetch-listings.js / build-listing-history.js
function historyKey(address, city) {
  return `${address}|${city}`.toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

function loadListingHistory() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'listing-history.json'), 'utf8');
    const homes = JSON.parse(raw).homes || {};
    // Earliest firstSeen = when feed tracking began. Homes already listed then
    // have an unknown earlier start, so their estimated DOM is only a floor.
    let trackingStart = null;
    for (const h of Object.values(homes)) {
      if (h.firstSeen && (!trackingStart || h.firstSeen < trackingStart)) trackingStart = h.firstSeen;
    }
    return { homes, trackingStart };
  } catch (e) {
    console.warn('No listing-history.json found — sale vs list comparison will be empty');
    return { homes: {}, trackingStart: null };
  }
}

// Attach the list price we archived while the home was an active listing,
// so the UI can show final sale price vs asking price.
function attachListPrice(home, historyHomes, trackingStart) {
  const hist = historyHomes[historyKey(home.address, home.city || '')];
  if (!hist) return home;
  home.listPrice = hist.listPrice;
  home.listPriceFormatted = formatPrice(hist.listPrice);
  home.origListPrice = hist.origListPrice;
  if (home.salePrice) {
    home.priceDiff = home.salePrice - hist.listPrice;
    home.priceDiffPct = Math.round((home.priceDiff / hist.listPrice) * 1000) / 10;
  }
  if (!home.photoUrl && hist.photoUrl) home.photoUrl = hist.photoUrl;
  if (hist.priceHistory && hist.priceHistory.length) home.priceHistory = hist.priceHistory;
  if (hist.listedDate) home.listedDate = hist.listedDate;
  // Redfin's sold CSV leaves DAYS ON MARKET blank. Best available substitute:
  // 1. Exact list -> pending dates from the backfilled Redfin property history
  // 2. List date -> sold date (overstates by the closing period, so marked ~)
  // 3. How long the home stayed in the daily listings feed (marked ~)
  if (home.dom == null) {
    if (hist.listedDate && hist.pendingDate) {
      const days = Math.round((new Date(hist.pendingDate) - new Date(hist.listedDate)) / 86400000);
      if (days >= 0) home.dom = days;
    } else if (hist.listedDate && (home.soldDate || hist.lastSeen)) {
      const end = home.soldDate || hist.lastSeen;
      const days = Math.round((new Date(end) - new Date(hist.listedDate)) / 86400000);
      if (days >= 0) { home.dom = days; home.domEstimated = true; }
    } else if (hist.firstSeen && hist.lastSeen) {
      const days = Math.round((new Date(hist.lastSeen) - new Date(hist.firstSeen)) / 86400000);
      if (days >= 0) {
        home.dom = days;
        home.domEstimated = true;
        // Listed before tracking began -> true DOM is at least this
        if (trackingStart && hist.firstSeen === trackingStart) home.domFloor = true;
      }
    }
  }
  return home;
}

// Fetch homes under agreement (offer accepted, sale not yet closed) from the
// JSON GIS endpoint. status=130 = contingent + pending/under-agreement; the
// status filter only takes effect when market/mpt/start are present (this is
// the exact query shape redfin.com itself uses for status=contingent+pending).
// These have no final sale price yet, only the list price.
async function fetchTownPending(townName, regionId) {
  const params = new URLSearchParams({
    al: '1', market: 'boston', mpt: '99', start: '0', num_homes: '350',
    ord: 'redfin-recommended-asc',
    page_number: '1', sf: '1,2,3,5,6,7', status: '130',
    uipt: '1', v: '8',
    min_listing_approx_size: '1600', min_num_beds: '3', min_num_baths: '1.5',
    min_lot_size: '10000',
    region_id: String(regionId), region_type: '6',
  });

  const url = `https://www.redfin.com/stingray/api/gis?${params.toString()}`;
  const data = await fetchUrl(url, { 'Referer': 'https://www.redfin.com/' });
  const parsed = JSON.parse(data.replace(/^\{\}&&/, ''));

  if (!parsed.payload?.homes) return [];

  return parsed.payload.homes
    .filter(h => h.latLong?.value?.latitude && h.latLong?.value?.longitude)
    .filter(h => h.uiPropertyType === 1) // Single-family only
    .filter(h => h.price?.value >= 650000 && h.price.value <= 1100000)
    .map(h => ({
      id: h.propertyId,
      address: h.streetLine?.value || 'Unknown',
      city: h.city || townName,
      state: h.state || 'MA',
      zip: h.zip || h.postalCode?.value || '',
      lat: h.latLong.value.latitude,
      lon: h.latLong.value.longitude,
      listPrice: h.price?.value || 0,
      listPriceFormatted: formatPrice(h.price?.value),
      beds: h.beds || 0,
      baths: h.baths || 0,
      sqft: h.sqFt?.value || 0,
      lotSqft: h.lotSize?.value || 0,
      yearBuilt: h.yearBuilt?.value || null,
      dom: h.timeOnRedfin?.value != null ? Math.max(0, Math.round(h.timeOnRedfin.value / 86400000)) : null,
      redfinUrl: h.url ? `https://www.redfin.com${h.url}` : null,
      status: h.mlsStatus || 'Pending',
      townMatch: townName,
    }));
}

async function fetchTownSold(townName, regionId) {
  // gis-csv endpoint with sold_within_days=150 returns actual sold data
  // uipt=1 = single-family only
  const params = new URLSearchParams({
    al: '1',
    num_homes: '350',
    ord: 'redfin-recommended-asc',
    page_number: '1',
    sold_within_days: '150',
    uipt: '1',
    v: '8',
    region_id: String(regionId),
    region_type: '6',
  });

  const url = `https://www.redfin.com/stingray/api/gis-csv?${params.toString()}`;
  const csv = await fetchUrl(url, { 'Referer': 'https://www.redfin.com/' });

  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // First line is headers
  const headers = parseCSVRow(lines[0]);
  const colIdx = {};
  headers.forEach((h, i) => { colIdx[h] = i; });

  const homes = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCSVRow(lines[i]);
    // Skip disclaimer rows
    if (row[0] === 'In accordance with local MLS rules') continue;
    if (!row[colIdx['ADDRESS']]) continue;

    const price = parseInt(row[colIdx['PRICE']], 10) || 0;
    // Filter: $650K-$1.1M
    if (price < 650000 || price > 1100000) continue;

    const lat = parseFloat(row[colIdx['LATITUDE']]);
    const lon = parseFloat(row[colIdx['LONGITUDE']]);
    if (!lat || !lon) continue;

    const soldDate = parseSoldDate(row[colIdx['SOLD DATE']]);
    const yearBuilt = parseInt(row[colIdx['YEAR BUILT']], 10) || null;
    const sqft = parseInt(row[colIdx['SQUARE FEET']], 10) || 0;
    const lotSize = parseInt(row[colIdx['LOT SIZE']], 10) || 0;
    const dom = parseInt(row[colIdx['DAYS ON MARKET']], 10) || null;
    const beds = parseInt(row[colIdx['BEDS']], 10) || 0;
    const baths = parseFloat(row[colIdx['BATHS']]) || 0;
    const ppsqft = parseInt(row[colIdx['$/SQUARE FEET']], 10) || null;
    const redfinUrl = row[colIdx['URL (SEE https://www.redfin.com/buy-a-home/comparative-market-analysis FOR INFO ON PRICING)']];

    homes.push({
      address: row[colIdx['ADDRESS']] || 'Unknown',
      city: row[colIdx['CITY']] || townName,
      state: row[colIdx['STATE OR PROVINCE']] || 'MA',
      zip: row[colIdx['ZIP OR POSTAL CODE']] || '',
      lat,
      lon,
      salePrice: price,
      salePriceFormatted: formatPrice(price),
      soldDate,
      beds,
      baths,
      sqft,
      lotSqft: lotSize,
      priceSqft: ppsqft,
      yearBuilt,
      dom,
      redfinUrl: redfinUrl || null,
      status: row[colIdx['STATUS']] || 'Sold',
      townMatch: townName,
    });
  }

  return homes;
}

async function main() {
  // Test with Beverly first
  console.log('Testing with Beverly (region_id=1490)...');
  const testResults = await fetchTownSold('Beverly', 1490);
  console.log(`  Beverly: ${testResults.length} sold homes found in price range`);
  if (testResults.length > 0) {
    const s = testResults[0];
    console.log(`  Sample: ${s.address}, ${s.city} — ${s.salePriceFormatted}, sold ${s.soldDate}, ${s.beds}bd/${s.baths}ba, ${s.sqft}sqft`);
  }

  // Fetch all towns
  console.log(`\nFetching sold homes from ${Object.keys(TOWN_IDS).length} towns...`);
  const allSold = [];
  const townEntries = Object.entries(TOWN_IDS);
  const townCounts = {};

  for (let i = 0; i < townEntries.length; i += 5) {
    const batch = townEntries.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(([name, id]) => fetchTownSold(name, id))
    );
    for (let j = 0; j < results.length; j++) {
      const [townName] = batch[j];
      if (results[j].status === 'fulfilled') {
        const homes = results[j].value;
        townCounts[townName] = homes.length;
        allSold.push(...homes);
      } else {
        townCounts[townName] = `ERROR: ${results[j].reason?.message}`;
        console.error(`  ${townName}: ${results[j].reason?.message}`);
      }
    }
    const batchNames = batch.map(([n]) => n).join(', ');
    console.log(`  Batch ${Math.floor(i / 5) + 1}: ${batchNames}`);
    if (i + 5 < townEntries.length) await sleep(400);
  }

  // Deduplicate by address+city (CSV doesn't have propertyId)
  const seen = new Set();
  const unique = allSold.filter(h => {
    const key = `${h.address}|${h.city}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\nTotal: ${unique.length} unique sold homes (${allSold.length} before dedup)`);

  // Attach archived list prices for sale-vs-list comparison
  const { homes: historyHomes, trackingStart } = loadListingHistory();
  unique.forEach(h => attachListPrice(h, historyHomes, trackingStart));
  const withList = unique.filter(h => h.listPrice).length;
  console.log(`Matched list prices for ${withList}/${unique.length} sold homes`);

  // Fetch under-agreement homes (offer accepted, no final price yet)
  console.log(`\nFetching pending/under-agreement homes...`);
  const allPending = [];
  for (let i = 0; i < townEntries.length; i += 5) {
    const batch = townEntries.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(([name, id]) => fetchTownPending(name, id))
    );
    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'fulfilled') allPending.push(...results[j].value);
      else console.error(`  ${batch[j][0]} pending: ${results[j].reason?.message}`);
    }
    if (i + 5 < townEntries.length) await sleep(400);
  }
  const pendingSeen = new Set();
  const pending = allPending.filter(h => {
    const key = `${h.address}|${h.city}`;
    if (pendingSeen.has(key)) return false;
    pendingSeen.add(key);
    return true;
  });
  pending.forEach(h => attachListPrice(h, historyHomes, trackingStart));
  console.log(`Total: ${pending.length} unique pending homes`);
  console.log('\nPer-town counts:');
  for (const [town, count] of Object.entries(townCounts).sort((a, b) => {
    const ac = typeof a[1] === 'number' ? a[1] : -1;
    const bc = typeof b[1] === 'number' ? b[1] : -1;
    return bc - ac;
  })) {
    console.log(`  ${town}: ${count}`);
  }

  // Price stats
  if (unique.length > 0) {
    const prices = unique.map(h => h.salePrice).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const avg = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    console.log(`\nPrice stats: median ${formatPrice(median)}, avg ${formatPrice(avg)}, range ${formatPrice(prices[0])}-${formatPrice(prices[prices.length - 1])}`);
  }

  // Save output
  const output = {
    sold: unique,
    pending,
    count: unique.length,
    pendingCount: pending.length,
    fetchedAt: new Date().toISOString(),
    soldWithinDays: 150,
    priceRange: { min: 650000, max: 1100000 },
    filter: 'single-family only',
  };

  const json = JSON.stringify(output);
  const publicDir = path.join(__dirname, '..', 'public');
  if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

  const publicPath = path.join(publicDir, 'sold.json');
  const rootPath = path.join(__dirname, '..', 'sold.json');
  fs.writeFileSync(publicPath, json);
  fs.writeFileSync(rootPath, json);
  console.log(`\nSaved to ${publicPath} and ${rootPath} (${(json.length / 1024).toFixed(0)} KB)`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { historyKey, loadListingHistory, attachListPrice, formatPrice, fetchUrl, sleep };
