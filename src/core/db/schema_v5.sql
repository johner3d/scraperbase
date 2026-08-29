-- Distinguish an unknown variant count on an index-only card from a known
-- count on a fully hydrated card. A stub has not been inspected for physical
-- issues yet, so reporting zero variants would be misleading.

DROP VIEW IF EXISTS v_card_search;

CREATE VIEW v_card_search AS
SELECT
  c.card_id,
  s.set_id,
  s.language,
  s.source_set_id,
  s.name AS set_name,
  s.series,
  s.release_date,
  c.local_id,
  c.local_sort_key,
  c.detail_status,
  c.number,
  c.name,
  c.category,
  c.rarity,
  c.image_url,
  CASE
    WHEN c.detail_status = 'hydrated' THEN COUNT(v.variant_id)
    ELSE NULL
  END AS variant_count
FROM cards c
JOIN sets s ON s.set_id = c.set_id
LEFT JOIN variants v ON v.card_id = c.card_id
GROUP BY c.card_id;
