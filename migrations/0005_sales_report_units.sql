-- Sales and Trends rows: `units` becomes paid units net of refunds (free trial starts and free downloads are counted in
-- `free_units`), and refunds subtract from customer_price_usd. Reports imported before this were aggregated with
-- trial starts and refunds mixed in (diluted per-unit proceeds), so they are cleared to be downloaded again.
ALTER TABLE sales_reports ADD COLUMN free_units INTEGER NOT NULL DEFAULT 0;
DELETE FROM sales_reports;
DELETE FROM settings WHERE key LIKE 'sales_report:%';
