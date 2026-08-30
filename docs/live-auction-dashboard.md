# Live PSA 10 auction dashboard

The web app exposes `/auctions` for trusted, single-card PSA 10 eBay auctions
with at least one bid that end in the next 72 hours. A trusted row has an
`exact` or `strong` variant match and is neither flagged nor a lot. Auction
detail pages remain readable after an item ends.

## Refresh workflow

The production Browse API allowance observed for this App ID is 5,000 calls
per day. A live sweep currently resolves roughly 600 item details, so run it
no more often than about every four hours unless the allowance changes:

```powershell
npm run cli -- run --source ebay --live-auctions
npm run cli -- materialize --source ebay
```

The live search collector deliberately re-arms qualifying item-detail jobs so
repeat sweeps append changed bids instead of acting as discovery-only runs.

Fetch the ECB daily EUR reference rates once per working day, normally after
the ECB's afternoon publication:

```powershell
npm run cli -- run --source ecb
npm run cli -- materialize --source ecb
```

`run --source ecb` re-arms its durable daily work item automatically. The
explicit `refresh --source ecb --stage rates` command remains available for
recovery. A full `materialize` includes ECB, eBay, PSA, and TCGdex.

## Comparison rules

The dashboard keeps the original eBay currency visible. For EUR auctions it
converts the PSA 10 USD guide using the latest stored ECB USD-per-EUR rate:

`PSA guide EUR = PSA guide USD / ECB rate`

`Bid vs guide = (PSA guide EUR - current bid EUR) / PSA guide EUR`

Rates older than seven calendar days are not used. Comparisons never fall
back to PSA averages or completed sales, and exclude shipping, tax, fees, and
currency-conversion spreads. They are context, not profit estimates.
