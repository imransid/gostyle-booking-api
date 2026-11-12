-- Give a tenant back to bookings the nightly series materialiser wrote
-- without one.
--
-- The materialiser runs at 02:00 with no request, so no header and no token,
-- and wrote every booking it made with tenant_id NULL. Those bookings cannot
-- reach the general ledger (it posts per tenant) and are invisible to
-- anything tenant-scoped. The code now runs each series as its own tenant
-- (MaterialiseSeriesHandler.inSeriesTenant); this repairs what it already
-- wrote.
--
-- EXACT, NOT INFERRED: the tenant comes from the booking's OWN series, which
-- took it from the request that created it. Nothing is guessed from a branch
-- or a neighbour. A booking with no series, or whose series has no tenant
-- either, is left NULL -- it needs the caller to have sent one.
--
-- Re-runnable (CLAUDE.md 3): it only ever touches rows still NULL.

-- Desk series: the occurrence names the booking it became.
UPDATE booking b
   SET tenant_id = s.tenant_id
  FROM series_occurrence o
  JOIN booking_series s ON s.id = o.series_id
 WHERE o.booking_id = b.id
   AND b.tenant_id IS NULL
   AND s.tenant_id IS NOT NULL;

-- Mobile routines: the booking names its series directly.
UPDATE booking b
   SET tenant_id = s.tenant_id
  FROM booking_series s
 WHERE b.series_id = s.id
   AND b.tenant_id IS NULL
   AND s.tenant_id IS NOT NULL;
