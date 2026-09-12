// Uses a real headless Chromium browser (via Playwright) to load NSE's
// option-chain page exactly like a real visitor would — full JS
// execution, real browser fingerprint — then listens for the same
// network response the page itself receives, rather than trying to
// replicate NSE's request/cookie dance ourselves.
//
// This is a genuinely different approach from the plain-fetch Worker and
// the plain-fetch GitHub Action script (both blocked identically) —
// those never executed JavaScript or looked like a real browser session
// at the network level. This might get further. It might not — some
// anti-bot systems also fingerprint headless browsers specifically.
//
// Usage: node fetch-option-chain-browser.js NIFTY index
//        node fetch-option-chain-browser.js RELIANCE equity

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'fs'

function computeMaxPain(rows) {
  let maxPainStrike = null
  let minPayout = Infinity
  for (const candidate of rows) {
    let payout = 0
    for (const r of rows) {
      payout += (r.callOi || 0) * Math.max(0, candidate.strike - r.strike)
      payout += (r.putOi || 0) * Math.max(0, r.strike - candidate.strike)
    }
    if (payout < minPayout) {
      minPayout = payout
      maxPainStrike = candidate.strike
    }
  }
  return maxPainStrike
}

function summarize(records) {
  const expiry = records.expiryDates?.[0]
  const spot = records.underlyingValue
  const allRows = (records.data || [])
    .filter((r) => r.expiryDate === expiry && r.CE && r.PE)
    .map((r) => ({
      strike: r.strikePrice,
      callOi: r.CE.openInterest || 0,
      callOiChange: r.CE.changeinOpenInterest || 0,
      callLtp: r.CE.lastPrice,
      callIv: r.CE.impliedVolatility,
      putOi: r.PE.openInterest || 0,
      putOiChange: r.PE.changeinOpenInterest || 0,
      putLtp: r.PE.lastPrice,
      putIv: r.PE.impliedVolatility
    }))

  if (allRows.length === 0) return { error: 'No option rows for this expiry' }

  const totalCallOi = allRows.reduce((s, r) => s + r.callOi, 0)
  const totalPutOi = allRows.reduce((s, r) => s + r.putOi, 0)
  const pcr = totalCallOi ? Number((totalPutOi / totalCallOi).toFixed(2)) : null
  const maxPain = computeMaxPain(allRows)
  const atmRow = [...allRows].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0]
  const atmIv = atmRow ? Number(((atmRow.callIv + atmRow.putIv) / 2).toFixed(1)) : null
  const netCallOiChange = allRows.reduce((s, r) => s + r.callOiChange, 0)
  const netPutOiChange = allRows.reduce((s, r) => s + r.putOiChange, 0)
  const displayRows = [...allRows]
    .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    .slice(0, 6)
    .sort((a, b) => a.strike - b.strike)
    .map((r) => ({ strike: r.strike, callOi: r.callOi, callLtp: r.callLtp, putOi: r.putOi, putLtp: r.putLtp }))

  return { spot, expiry, pcr, maxPain, atmIv, netCallOiChange, netPutOiChange, rows: displayRows }
}

async function fetchViaRealBrowser(symbol, type) {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  })

  // Log every request that actually goes to nseindia.com, so if our
  // guessed URL pattern is wrong, we can see what the real one was
  // instead of guessing again blindly.
  const nseRequests = []
  page.on('request', (req) => {
    if (req.url().includes('nseindia.com')) nseRequests.push(req.url())
  })

  const apiUrlFragment = type === 'equity' ? 'option-chain-equities' : 'option-chain-indices'
  const pageUrl =
    type === 'equity'
      ? `https://www.nseindia.com/get-quotes/derivatives?symbol=${symbol}`
      : 'https://www.nseindia.com/option-chain'

  const responsePromise = page
    .waitForResponse((res) => res.url().includes(apiUrlFragment) && res.url().includes(symbol), {
      timeout: 20000
    })
    .catch(() => null)

  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null)
  await page.waitForTimeout(5000) // give any client-side JS extra time to fire its own requests

  const response = await responsePromise

  // Diagnostics, captured regardless of success/failure
  const finalUrl = page.url()
  const title = await page.title().catch(() => 'unknown')
  mkdirSync('data', { recursive: true })
  await page.screenshot({ path: `data/debug-screenshot-${symbol.toLowerCase()}.png`, fullPage: false }).catch(() => null)

  await browser.close()

  const diagnostics = {
    finalUrl,
    title,
    nseRequestsSeen: nseRequests.length,
    sampleNseRequests: nseRequests.slice(0, 15) // first 15, enough to spot the real pattern
  }

  if (!response) return { error: 'No matching network response seen within timeout', diagnostics }
  if (!response.ok()) return { error: `NSE returned ${response.status()} (via real browser)`, diagnostics }

  const data = await response.json().catch(() => null)
  const records = data?.records
  if (!records || !records.data) {
    return { error: 'no-options', raw: data ? 'got JSON but no records.data' : 'could not parse JSON', diagnostics }
  }

  return { ...summarize(records), diagnostics }
}

const [, , symbol, type] = process.argv
if (!symbol) {
  console.error('Usage: node fetch-option-chain-browser.js SYMBOL [equity|index]')
  process.exit(1)
}

const result = await fetchViaRealBrowser(symbol, type === 'equity' ? 'equity' : 'index')
result.fetchedAt = new Date().toISOString()
result.method = 'headless-browser'

mkdirSync('data', { recursive: true })
const filename = `data/option-chain-${symbol.toLowerCase()}.json`
writeFileSync(filename, JSON.stringify(result, null, 2))
console.log(`Wrote ${filename}:`, JSON.stringify(result).slice(0, 300))
