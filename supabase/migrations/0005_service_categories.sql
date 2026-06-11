-- ============================================================
-- 0005: Assign categories to existing services
--
-- services.category was added in 0002 but never populated. The booking
-- page groups the service list by these values, and category-scoped
-- discount codes match against them. Idempotent — safe to re-run.
-- New services added later through the admin UI should be given one of
-- these categories (or a new one — the frontend picks up unknown
-- categories automatically; uncategorized services show under "Other").
-- ============================================================

update services set category = 'Haircuts' where name in (
  'Women''s Haircut',
  'Men''s Haircut',
  'Kids Haircut',
  'Basic Trim (one length no layers 1-4 inches)',
  'Fades (mid / low / high / tapers / bold shaves)',
  'Shampoo + Deep Conditioning + Haircut & Style'
);

update services set category = 'Color' where name in (
  'All-Over Color',
  'Root Touch-Up',
  'Full Highlight',
  'Partial Highlight',
  'Highlight & Lowlight',
  'Vivids (halo / peekaboo / calico / ghost roots)',
  'Prisms (Full)',
  'Prisms (Partial)'
);

update services set category = 'Perms' where name in (
  'Perm (Long Hair)',
  'Perm (Short Hair)',
  'Perm (Top Only)'
);

update services set category = 'Extensions' where name in (
  'Extension Installation (custom order)',
  'Extension Installation (your own extensions)',
  'Extension Move-Ups (per row)',
  'Extension Removal (per row)',
  'Extension Removal + Shampoo & Style',
  'Shampoo & Style with Extensions',
  'Refusion'
);

update services set category = 'Treatments & Styling' where name in (
  'Deep Conditioning Treatment',
  'K18 / Olaplex Treatment',
  'Detangle + Shampoo + Deep Conditioning',
  'Shampoo & Blowdry / Style'
);

update services set category = 'Waxing' where name in (
  'Brow Wax',
  'Lip Wax'
);

update services set category = 'Add-Ons' where name like 'Add-On:%';

update services set category = 'Other' where name in (
  'Consultation',
  'Silent Appointment'
);
