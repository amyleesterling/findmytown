#!/usr/bin/env node
// Backfills listing history for sold homes that were never captured by the
// daily feed snapshots (sold before tracking began June 2026, or sold
// off-feed). Queries Redfin's per-property history API for each one and
// merges the real listing events — list date, original price, price cuts,
// pending date — into listing-history.json, then re-attaches list prices to
// sold.json so the UI updates without waiting for the next fetch-sold run.
//
// Idempotent: skips homes whose history entry already has a listedDate, so
// after the first full pass the daily run only fills new gaps. Exits 0 on
// network failure so it never blocks the refresh workflow.
const fs = require('fs');
const path = require('path');
const { historyKey, loadListingHistory, attachListPrice, fetchUrl, sleep } = require('./fetch-sold');

const rootDir = path.join(__dirname, '..');

function propertyIdFromUrl(redfinUrl) {
  const m = (redfinUrl || '').match(/\/home\/(\d+)/);
  return m ? m[1] : null;
}

function toDateStr(ms) {
  if (!ms) return null;
  const d = new Date(ms);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Pull the listing events for the sale period that matches soldDate out of
// Redfin's property history payload. Events arrive newest-first.
function extractListing(events, soldDate) {
  const evs = events
    .map(e => ({
      date: toDateStr(e.eventDate),
      price: e.price || null,
      desc: (e.eventDescription || e.historyEventType || '').toString(),
    }))
    .filter(e => e.date)
    .sort((a, b) => a.date.localeCompare(b.date)); // oldest first

  // Find the sold event closest to the CSV's soldDate (within 45 days)
  const soldEvents = evs.filter(e => /sold/i.test(e.desc));
  let sold = null;
  if (soldDate) {
    sold = soldEvents
      .filter(e => Math.abs(new Date(e.date) - new Date(soldDate)) < 45 * 86400000)
      .pop() || null;
  }
  if (!sold) sold = soldEvents[soldEvents.length - 1] || null;
  if (!sold) return null;

  // Walk backwards from the sale to the start of that listing period
  const before = evs.filter(e => e.date <= sold.date && e !== sold);
  const listedIdx = before.map(e => /listed|relisted/i.test(e.desc)).lastIndexOf(true);
  const period = listedIdx >= 0 ? before.slice(listedIdx) : before;

  const listed = listedIdx >= 0 ? before[listedIdx] : null;
  const priceEvents = period.filter(e => e.price && /listed|relisted|price/i.test(e.desc));
  if (!priceEvents.length) return null;

  const pending = period.filter(e => /pending|contingent/i.test(e.desc)).pop() || null;

  return {
    listedDate: listed ? listed.date : priceEvents[0].date,
    pendingDate: pending ? pending.date : null,
    origListPrice: priceEvents[0].price,
    listPrice: priceEvents[priceEvents.length - 1].price,
    priceHistory: priceEvents
      .map(e => ({ date: e.date, price: e.price, event: /price/i.test(e.desc) ? 'Price Changed' : 'Listed' }))
      .concat([{ date: sold.date, price: sold.price || null, event: 'Sold' }]),
  };
}

async function fetchPropertyHistory(propertyId) {
  const url = `https://www.redfin.com/stingray/api/home/details/belowTheFold?propertyId=${propertyId}&accessLevel=1`;
  const data = await fetchUrl(url, { 'Referer': 'https://www.redfin.com/' });
  const parsed = JSON.parse(data.replace(/^\{\}&&/, ''));
  const events = parsed.payload?.propertyHistoryInfo?.events;
  if (!Array.isArray(events) || !events.length) throw new Error('no history events in payload');
  return events;
}

async function main() {
  const soldPath = path.join(rootDir, 'sold.json');
  let soldData;
  try {
    soldData = JSON.parse(fs.readFileSync(soldPath, 'utf8'));
  } catch (e) {
    console.log('No sold.json — nothing to backfill');
    return;
  }

  const historyPath = path.join(rootDir, 'listing-history.json');
  let history = { homes: {} };
  try {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    if (!history.homes) history.homes = {};
  } catch (e) { /* start fresh */ }

  const targets = (soldData.sold || []).filter(h => {
    const hist = history.homes[historyKey(h.address, h.city || '')];
    return !(hist && hist.listedDate) && propertyIdFromUrl(h.redfinUrl);
  });
  console.log(`${targets.length} sold homes need listing-history backfill`);
  if (!targets.length) return;

  let filled = 0, failed = 0, consecutiveFailures = 0;
  for (const home of targets) {
    const propertyId = propertyIdFromUrl(home.redfinUrl);
    try {
      const events = await fetchPropertyHistory(propertyId);
      const listing = extractListing(events, home.soldDate);
      consecutiveFailures = 0;
      if (!listing) { failed++; continue; }

      const key = historyKey(home.address, home.city || '');
      const existing = history.homes[key] || {
        id: Number(propertyId) || propertyId,
        address: home.address,
        city: home.city,
        photoUrl: home.photoUrl || null,
        redfinUrl: home.redfinUrl || null,
      };
      // Redfin's own event log is authoritative over feed-snapshot estimates
      existing.listPrice = listing.listPrice;
      existing.origListPrice = listing.origListPrice;
      existing.listedDate = listing.listedDate;
      if (listing.pendingDate) existing.pendingDate = listing.pendingDate;
      existing.priceHistory = listing.priceHistory;
      existing.source = 'redfin-history';
      history.homes[key] = existing;
      filled++;
      if (filled % 25 === 0) console.log(`  ${filled}/${targets.length} backfilled...`);
    } catch (err) {
      failed++;
      consecutiveFailures++;
      if (consecutiveFailures <= 3) console.error(`  ${home.address}, ${home.city}: ${err.message}`);
      // Endpoint blocked or rate-limited — bail without breaking the workflow
      if (consecutiveFailures >= 8 && filled === 0) {
        console.error('Property-history endpoint appears unreachable — skipping backfill');
        return;
      }
      if (consecutiveFailures >= 20) {
        console.error('Too many consecutive failures — saving partial progress and stopping');
        break;
      }
    }
    await sleep(350);
  }

  console.log(`Backfilled ${filled}, failed ${failed}`);
  if (!filled) return;

  history.count = Object.keys(history.homes).length;
  history.updatedAt = new Date().toISOString();
  fs.writeFileSync(historyPath, JSON.stringify(history));
  console.log(`Saved ${historyPath}`);

  // Re-attach list prices to sold.json immediately (same logic as fetch-sold).
  // Drop previously estimated DOMs first so exact backfilled dates win.
  const { homes: historyHomes, trackingStart } = loadListingHistory();
  (soldData.sold || []).forEach(h => {
    if (h.domEstimated) { delete h.dom; delete h.domEstimated; delete h.domFloor; }
    attachListPrice(h, historyHomes, trackingStart);
  });
  (soldData.pending || []).forEach(h => attachListPrice(h, historyHomes, trackingStart));
  const json = JSON.stringify(soldData);
  fs.writeFileSync(soldPath, json);
  fs.writeFileSync(path.join(rootDir, 'public', 'sold.json'), json);
  const withList = (soldData.sold || []).filter(h => h.listPrice).length;
  console.log(`sold.json updated: ${withList}/${(soldData.sold || []).length} sold homes now have list prices`);
}

main().catch(err => {
  // Never fail the refresh workflow over the backfill
  console.error('Backfill error (non-fatal):', err.message);
});
