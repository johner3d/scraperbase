# Local web app

The card explorer is a read-only React/Vite application backed by the existing
SQLite database. The server binds to all network interfaces so Safari on an
iPhone can use it over the same private Wi-Fi network.

## Start it

Build and start the production server:

```text
npm run web:build
npm run web
```

For frontend development with Vite:

```text
npm run web:dev
```

The server prints both addresses at startup:

```text
Local: http://localhost:8787
LAN:   http://192.168.x.x:8787
```

Connect the PC and iPhone to the same Wi-Fi, then open the printed LAN URL in
Safari. The page can optionally be added to the iPhone Home Screen. If the
page cannot be reached, allow TCP port `8787` for the Windows Firewall Private
network profile.

## Populate the catalogue

The web app does not write to SQLite. Run collection and materialization from
the project directory:

```text
npm run cli -- run --source tcgdex
npm run cli -- materialize
```

PSA records are shown as partial/unresolved until they can be matched to a
materialized card variant. `data/psa-raw-test` is never included in production
materialization.

## Routes

The frontend uses `/` for card browsing, `/sources` for operational status,
`/cards/:cardId` for card detail, and `/variants/:variantId` for exact issue
detail. The read-only API is under `/api` and local object-store images are
served through `/media/:assetId`.
# Local access

Build and run the single-origin server:

```text
npm run web:build
npm run web
```

Open the printed LAN URL from an iPhone on the same Wi-Fi. The server opens
SQLite read-only. Its only write is a disposable, URL-hashed image cache under
`data/media-cache`; permanent raw objects and catalogue data remain importer
owned.
