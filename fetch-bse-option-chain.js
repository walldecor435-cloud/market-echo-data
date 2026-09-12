// Uses a real headless Chromium browser to load BSE's actual option
// chain page and listens for any JSON response from bseindia.com's API
// domain — rather than guessing the exact endpoint name in advance, we
// let the real page tell us what it actually calls.
//
// This targets BSE specifically because independent evidence suggests
// it's far less defended against datacenter/automated access than NSE
// (which we conclusively confirmed is blocked at the connection level
// even via headless browser). Sensex = scrip code 1.
//
// Usage: node fetch-bse-option-chain.js

import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'fs'

const PAGE_URL = 'https://www.bseindia.com/markets/Derivatives/DeriReports/DeriOptionchain'

async function fetchBseOptionChain() {
  const browser = await chromium.launch()
  const page = await browser.newPage({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  })

  const jsonResponses = [] // every JSON response seen, so we can inspect what's real
  page.on('response', async (res) => {
    const url = res.url()
    if (!url.includes('bseindia.com')) return
    const contentType = res.headers()['content-type'] || ''
    if (!contentType.includes('json')) return
    try {
      const body = await res.json()
      jsonResponses.push({ url, sample: JSON.stringify(body).slice(0, 500) })
    } catch {
      // not parseable JSON despite the content-type header, skip it
    }
  })

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((err) => {
    jsonResponses.push({ url: 'NAVIGATION_ERROR', sample: String(err) })
  })
  await page.waitForTimeout(6000) // let any client-side JS fire its own requests

  const finalUrl = page.url()
  const title = await page.title().catch(() => 'unknown')
  mkdirSync('data', { recursive: true })
  await page.screenshot({ path: 'data/debug-screenshot-bse.png', fullPage: false }).catch(() => null)

  await browser.close()

  return {
    finalUrl,
    title,
    jsonResponsesSeen: jsonResponses.length,
    responses: jsonResponses, // full list — this is the real answer either way
    fetchedAt: new Date().toISOString(),
    method: 'headless-browser-bse'
  }
}

const result = await fetchBseOptionChain()
mkdirSync('data', { recursive: true })
writeFileSync('data/bse-option-chain-raw.json', JSON.stringify(result, null, 2))
console.log('Wrote data/bse-option-chain-raw.json:', JSON.stringify(result).slice(0, 300))
