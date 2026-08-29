# eBay scraped data inventory

**Snapshot date:** 2026-08-29  
**Search term:** `pikachu psa 10`  
**Status:** DE raw import is mostly complete but paused at eBay's daily API
quota. EU and international data are probe samples only. No eBay acquisition
process is currently running.

This document records what the eBay raw importer has actually stored. It is an
inventory of captured API responses, not a claim that every matching eBay
listing has already been imported.

## Summary

| Scope | Search coverage | Successful item-detail calls | Current state |
|---|---:|---:|---|
| DE (`EBAY_DE`) | Two 25-page passes plus two probes | 4,936 | 39 detail jobs remain pending |
| EU countries on `EBAY_DE` | One one-result probe | 1 | Full import not started |
| International (`EBAY_US`) | Three probes | 4 | Full import not started; search must be partitioned |
| **All scopes** | **56 search responses** | **4,941 successful calls** | **4,997 successful HTTP 200 responses total** |

The object store currently contains **4,998 JSON files** using
**91,523,485 bytes**. This includes successful search and detail responses,
stored API error bodies, and content-addressed deduplication across identical
responses. There were **4,940 distinct successful item-detail payloads** when
the stored JSON was inspected; the difference from 4,941 successful calls is
an identical response deduplicated by content hash.

## DE import results

The first full DE pass used eBay's default buying-option view:

- 25 search pages
- 4,838 rows returned across the pages
- 4,691 unique item IDs observed in the moving result set
- 4,686 new item-detail fetches, plus five details already captured by the
  smoke test
- all 4,711 calls in the run succeeded

An API-documentation audit found that the default search view can omit active
auction-only listings after a bid. The importer was then changed to request
all four buying options explicitly:

`AUCTION|FIXED_PRICE|BEST_OFFER|CLASSIFIED_AD`

The corrected DE pass captured:

- 25 search pages
- 4,976 rows returned across the pages
- 4,925 unique item IDs within that pass
- 284 item IDs not seen in the earlier default-view pass
- 150 returned rows advertising an `AUCTION` buying option
- 245 additional successful item-detail responses before quota exhaustion

Buying-option combinations in those 4,976 returned rows were:

| Buying options | Rows |
|---|---:|
| `FIXED_PRICE` | 3,331 |
| `BEST_OFFER`, `FIXED_PRICE` | 1,495 |
| `AUCTION` | 110 |
| `AUCTION`, `BEST_OFFER` | 31 |
| `AUCTION`, `FIXED_PRICE` | 9 |

Across both passes, DE now has **4,975 item-detail work items**:

- 4,936 succeeded
- 39 remain pending

The corrected run received 26 HTTP 429 rate-limit responses. Their raw error
bodies were stored, and those item jobs were returned to the durable queue.
Another 13 queued items were never attempted after the quota was reached.
Together these make the 39 pending DE details.

The earlier default-view responses remain in history. They were not
overwritten by the corrected pass.

## EU and international samples

The EU scope uses `EBAY_DE` with item-location filters for DE, AT, FR, IT, ES,
NL, BE, PL, SE, DK, IE, PT, CZ, FI, and LU. Its live probe reported about
4,822 matching results and successfully stored one search page plus one item
detail. A full EU traversal has not been run.

The international scope uses `EBAY_US` without a location filter. Its probes
reported about 47,596 matching results. Three search responses and four
individual item details succeeded. A test of eBay's bulk item-detail endpoint
returned HTTP 403 and that raw error body was retained.

International cannot yet be imported completely as one Browse API result set:
eBay exposes at most 10,000 results for a search while this query currently
reports far more. Category and/or price partitioning must be implemented before
a full international run can make a completeness claim.

## Raw responses captured

Search responses are stored verbatim. Each response can contain the page URL,
reported total, pagination links and offsets, and the complete `itemSummaries`
array supplied by eBay. Item summaries can include IDs, titles, prices, seller,
condition, images, buying options, shipping, location, and category data.

Successful item-detail payloads were inspected only to inventory their shape;
the source JSON was not reduced or normalized. Across the stored payloads, the
following top-level fields occurred:

```text
additionalImages, adultOnly, ageGroup, authenticityGuarantee,
availableCoupons, bidCount, brand, buyingOptions, categoryId, categoryIdPath,
categoryPath, color, condition, conditionDescription, conditionDescriptors,
conditionId, currentBidPrice, description, eligibleForInlineCheckout,
enabledForGuestCheckout, epid, estimatedAvailabilities, gtin, image,
immediatePay, itemCreationDate, itemEndDate, itemId, itemLocation, itemWebUrl,
legacyItemId, listingMarketplaceId, localizedAspects, lotSize, manufacturer,
marketingPrice, material, minimumPriceToBid, mpn, paymentMethods, price,
primaryItemGroup, primaryProductReviewRating, priorityListing,
productSafetyLabels, qualifiedPrograms, repairScore, reservePriceMet,
responsiblePersons, returnTerms, seller, sellerItemRevision, shipToLocations,
shippingOptions, shortDescription, subtitle, taxes, title,
topRatedBuyingExperience, uniqueBidderCount, warnings
```

Nested data seen includes:

- price and bid values, currencies, and converted values
- condition descriptors and localized item aspects
- item location and ship-to regions
- primary and additional images
- seller username, account type, feedback score, and legal information
- estimated availability and sold/remaining quantities
- shipping service, cost, import charges, and estimated delivery dates
- returns, payment methods, taxes, coupons, and marketing discounts
- manufacturer and responsible-person contact/address data
- product-safety labels and warnings
- product-review ratings and rating histograms
- item-group metadata and authenticity-guarantee information

Fields are optional and vary by listing. The raw response preserves whatever
eBay returned for that request, including fields not useful to the current
card use case.

## Request and error totals

| Result | HTTP status | Stored attempts |
|---|---:|---:|
| Success | 200 | 4,997 |
| eBay daily rate limit | 429 | 26 |
| Unsupported/unavailable bulk endpoint probe | 403 | 1 |

The 4,997 successful responses comprise 56 searches and 4,941 item-detail
calls. Error response bodies are stored as raw evidence too; they are not
silently discarded.

## Where the data is stored

Raw response bodies are content-addressed JSON objects under:

```text
data/ebay-raw/ebay/json/<hash-prefix>/<content-hash>.json
```

Queue state and provenance are recorded in `data/db.sqlite`, primarily in the
`work_items`, `attempts`, `raw_objects`, and `observations` tables.

This provides history with deduplication:

- an identical response reuses its existing content hash and file
- a changed response creates a new object
- prior responses remain addressable through their attempts and observations
- failures are auditable because their response bodies and attempt metadata
  are retained

No structured catalogue rows have been produced from these files yet. No
title filtering, card matching, grading interpretation, or business-level
deduplication has been applied. The acquisition layer intentionally stores the
API response before downstream decisions can discard information.

## Import runs recorded

| Run | Outcome | Attempts | Raw bytes | Purpose |
|---|---|---:|---:|---|
| DE smoke | completed | 6 | 84,531 | One search page and five details |
| EU/international probe | completed | 4 | 35,999 | One-item scope checks |
| Bulk endpoint probe | completed | 2 | 3,424 | Search succeeded; bulk detail returned 403 |
| International individual probe | completed | 4 | 190,498 | Three item details fetched individually |
| Default-view DE import | completed | 4,711 | 77,891,316 | Initial full DE traversal |
| All-buying-options probe | completed | 1 | 2,472 | Validated corrected search filter |
| Corrected DE import | cancelled cleanly | 296 | 13,325,626 | Stopped at quota; pending work preserved |

“Cancelled cleanly” means the writer was stopped after the daily quota closed;
it does not mean the stored results were rolled back.

## What remains

1. Resume the queue after the eBay quota reset at **2026-08-30 07:00 UTC
   (09:00 Europe/Berlin)** and finish the 39 pending DE details.
2. Re-run the DE search iteratively. Search results move during pagination, so
   repeated passes are required to converge on listings that appeared between
   pages or runs.
3. Run the full EU import if EU coverage is desired.
4. Add safe category/price partitioning before attempting the full
   international import.
5. Build downstream parsing and matching separately, leaving these raw objects
   unchanged.

Resetting the router or obtaining a new public IP is not expected to restore
the quota because the observed limit is tied to the eBay application
credentials, not the client IP. There is currently no importer process to stop
before a router reset.

For implementation details, commands, and the smoke-test checklist, see
[`docs/ebay-raw-fetch.md`](./ebay-raw-fetch.md).
