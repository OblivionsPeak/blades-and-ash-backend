// Shared discount logic — used by the public validate endpoint AND by the
// payment/appointment flows so the server is the single source of truth for
// what a code is worth. Never trust a client-sent amount.

// Given a discount row and a price in cents, return the discounted price in
// cents. Percent → round to nearest cent; fixed → subtract; clamp at 0.
export function applyDiscount(discount, priceCents) {
  if (!discount) return priceCents;
  let result;
  if (discount.type === 'percent') {
    result = Math.round(priceCents * (1 - discount.value / 100));
  } else {
    // fixed: value is an absolute amount in cents
    result = priceCents - discount.value;
  }
  return Math.max(0, result);
}

// Short human-readable label for a discount, e.g. "10% off" or "$15 off".
export function discountLabel(discount) {
  if (discount.type === 'percent') {
    return `${discount.value}% off`;
  }
  return `$${(discount.value / 100).toFixed(2).replace(/\.00$/, '')} off`;
}

// Resolve a promo code against a single service. Returns either
//   { ok: true, discount, original_cents, discounted_cents, label }
// or
//   { ok: false, error: '<reason>' }
// `supabase` is the service-role client passed in by the caller.
export async function resolveDiscount(supabase, { code, service }) {
  if (!code || typeof code !== 'string') {
    return { ok: false, error: 'No code provided' };
  }

  const normalized = code.trim().toUpperCase();

  const { data: discount, error } = await supabase
    .from('discounts')
    .select('*')
    .eq('code', normalized)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!discount) return { ok: false, error: 'Code not found' };
  if (!discount.active) return { ok: false, error: 'Code is inactive' };

  if (discount.expires_at && new Date(discount.expires_at).getTime() < Date.now()) {
    return { ok: false, error: 'Code has expired' };
  }

  // scope is either the literal 'all' (matches any service) or a category name
  // that must equal the service's category.
  if (discount.scope !== 'all' && discount.scope !== service.category) {
    return { ok: false, error: 'Code does not apply to this service' };
  }

  const originalCents = service.price_cents;
  const discountedCents = applyDiscount(discount, originalCents);

  return {
    ok: true,
    discount,
    original_cents: originalCents,
    discounted_cents: discountedCents,
    label: discountLabel(discount),
  };
}
