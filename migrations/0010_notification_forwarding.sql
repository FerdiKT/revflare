-- Forwarding of App Store Server Notifications: each verified notification is also POSTed unchanged to this URL
-- (e.g. the app's RevenueCat notification URL), so a second service keeps receiving Apple's events.
ALTER TABLE apps ADD COLUMN forward_url TEXT;
-- Last forward attempt: JSON { at, status, error? }.
ALTER TABLE apps ADD COLUMN forward_status TEXT;
