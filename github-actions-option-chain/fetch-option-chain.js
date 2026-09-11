// Fetches NSE option chain data and writes it to data/option-chain-nifty.json
// and data/option-chain-<SYMBOL>.json (one file per symbol requested).
// Run by the GitHub Actions workflow on a schedule — same logic as
// option-chain-worker.js, just running from GitHub's IP range instead of
// Cloudflare's, since NSE appears to specifically defend against
// Cloudflare Worker traffic on this endpoint.
//
// Usage: node fetch-option-chain.js NIFTY index
//        node fetch-option-chain.js RELIANCE equity

import { writeFileSync, mkdirSync } from 'fs'

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function getSessionCookies() {
  const res = await fetch('https://www.nseindia.com/get-quotes/derivatives', {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }
  })
  return res.headers.get('set-cookie') || ''
}

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

async function fetchOptionChain(symbol, type) {
  const cookies = await getSessionCookies()
  const endpoint = type === 'equity' ? 'option-chain-equities' : 'option-chain-indices'
  const apiRes = await fetch(`https://www.nseindia.com/api/${endpoint}?symbol=${symbol}`, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.nseindia.com/get-quotes/derivatives',
      Cookie: cookies
    }
  })

  if (!apiRes.ok) {
    return { error: `NSE returned ${apiRes.status}`, fetchedAt: new Date().toISOString() }
  }

  const data = await apiRes.json()
  const records = data?.records
  if (!records || !records.data || records.data.length === 0) {
    return { error: 'no-options', fetchedAt: new Date().toISOString() }
  }

  const spot = records.underlyingValue
  const expiry = records.expiryDates?.[0]
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

  if (allRows.length === 0) {
    return { error: 'No option rows for this expiry', fetchedAt: new Date().toISOString() }
  }

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
    .map((r) => ({
      strike: r.strike,
      callOi: r.callOi,
      callLtp: r.callLtp,
      putOi: r.putOi,
      putLtp: r.putLtp
    }))

  return {
    spot,
    expiry,
    pcr,
    maxPain,
    atmIv,
    netCallOiChange,
    netPutOiChange,
    rows: displayRows,
    fetchedAt: new Date().toISOString()
  }
}

const [, , symbol, type] = process.argv
if (!symbol) {
  console.error('Usage: node fetch-option-chain.js SYMBOL [equity|index]')
  process.exit(1)
}

const result = await fetchOptionChain(symbol, type === 'equity' ? 'equity' : 'index')
mkdirSync('data', { recursive: true })
const filename = `data/option-chain-${symbol.toLowerCase()}.json`
writeFileSync(filename, JSON.stringify(result, null, 2))
console.log(`Wrote ${filename}:`, JSON.stringify(result).slice(0, 200))
