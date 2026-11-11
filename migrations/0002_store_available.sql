-- Whether Apple serves production App Store Server API data for the app: NULL unknown, 0 not released yet, 1 yes.
ALTER TABLE apps ADD COLUMN store_available INTEGER;
