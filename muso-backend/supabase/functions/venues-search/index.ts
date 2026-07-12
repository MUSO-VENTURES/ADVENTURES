// GET /venues-search?startLat=&startLng=&radiusMiles=25&budget=$$&category=
//
// Finds top-rated real venues near a point via the Yelp Fusion API, sorted
// by rating, filtered to the caller's budget ceiling, and upserts them into
// the `venues` table (keyed by yelp_id) so they can be wired into routes
// later. Returns the matched venues either way, even if the upsert fails
// for some of them, so the discovery UI always gets usable results.
//
// Requires a YELP_API_KEY secret (Supabase dashboard > Edge Functions >
// Secrets, or `supabase secrets set YELP_API_KEY=...`). Get a free key at
// https://www.yelp.com/developers/v3/manage_app — the free tier covers a
// generous number of calls/day, no billing account required.
//
// startLat/startLng default to the Livermore, CA 94551 pin, same default
// used by discovery-submit. radiusMiles defaults to 25 and is clamped to
// Yelp's own hard cap (~24.85 miles / 40,000 meters) regardless of what's
// requested, since Yelp's API won't search wider than that.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";

const DEFAULT_LAT = 37.6819;
const DEFAULT_LNG = -121.768;
const DEFAULT_RADIUS_MILES = 25;
const YELP_MAX_RADIUS_METERS = 40000; // ~24.85 miles, Yelp's hard cap

const VALID_BUDGETS: Record<string, string> = {
  "$": "1",
  "$$": "1,2",
  "$$$": "1,2,3",
  "$$$$": "1,2,3,4",
};

function milesToMeters(miles: number): number {
  return Math.round(miles * 1609.34);
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const yelpKey = Deno.env.get("YELP_API_KEY");
  if (!yelpKey) {
    return jsonResponse(
      { error: "YELP_API_KEY is not configured for this project yet." },
      501,
    );
  }

  const url = new URL(req.url);
  const startLat = Number(url.searchParams.get("startLat")) || DEFAULT_LAT;
  const startLng = Number(url.searchParams.get("startLng")) | DEFAULT_LNG;
  const radiusMilesParam = Number(url.searchParams.get("radiusMiles"));
  const radiusMiles = Number.isFinite(radiusMilesParam) && radiusMilesParam > 0
    ? radiusMilesParam
    : DEFAULT_RADIUS_MILES;
  const radiusMeters = Math.min(milesToMeters(radiusMiles), YELP_MAX_RADIUS_METERS);

  const budgetParam = url.searchParams.get("budget");
  const yelpPrice = budgetParam && VALID_BUDGETS[budgetParam] ? VALID_BUDGETS[budgetParam] : undefined;

  const category = url.searchParams.get("category") ?? undefined;
  const term = url.searchParams.get("term") ?? undefined;

  const yelpParams = new URLSearchParams({
    latitude: String(startLat),
    longitude: String(startLng),
    radius: String(radiusMeters),
    sort_by: "rating",
    limit: "20",
  });
  if (yelpPrice) yelpParams.set("price", yelpPrice);
  if (category) yelpParams.set("categories", category);
  if (term) yelpParams.set("term", term);

  let yelpData: Record<string, unknown>;
  try {
    const yelpRes = await fetch(
      `https://api.yelp.com/v3/businesses/search?${yelpParams.toString()}`,
      { headers: { Authorization: `Bearer ${yelpKey}` } },
    );
    if (!yelpRes.ok) {
      const errBody = await yelpRes.text();
      return jsonResponse(
        { error: `Yelp API error (${yelpRes.status}): ${errBody.slice(0, 300)}` },
        502,
      );
    }
    yelpData = await yelpRes.json();
  } catch (e) {
    return jsonResponse({ error: `Failed to reach Yelp: ${(e as Error).message}` }, 502);
  }

  const businesses = Array.isArray(yelpData.businesses) ? yelpData.businesses : [];

  const venues = businesses.map((b: Record<string, unknown>) => {
    const categories = Array.isArray(b.categories) ? b.categories as Record<string, unknown>[] : [];
    const coordinates = (b.coordinates ?? {}) as Record<string, unknown>;
    const location = (b.location ?? {}) as Record<string, unknown>;
    const displayAddress = Array.isArray(location.display_address)
      ? (location.display_address as string[]).join(", ")
      : null;

    return {
      yelp_id: b.id as string,
      name: b.name as string,
      category: categories[0]?.title as string | undefined ?? null,
      address: displayAddress,
      lat: coordinates.latitude as number | undefined ?? null,
      lng: coordinates.longitude as number | undefined ?? null,
      phone: (b.display_phone as string) || null,
      rating: (b.rating as number) ?? null,
      rating_count: (b.review_count as number) ?? null,
      source_url: (b.url as string)?.split("?")[0] ?? null,
      price: (b.price as string) ?? null,
    };
  });

  // Best-effort upsert into `venues` so these can be reused in routes later.
  // A Yelp hiccup or a missing yelp_id column (pre-migration) shouldn't
  // block returning results to the caller.
  try {
    const admin = getSupabaseAdmin();
    const rows = venues
      .filter((v) => v.yelp_id && v.lat != null && v.lng != null)
      .map((v) => ({
        yelp_id: v.yelp_id,
        name: v.name,
        category: v.category,
        address: v.address,
        lat: v.lat,
        lng: v.lng,
        phone: v.phone,
        rating: v.rating,
        rating_count: v.rating_count,
        source_url: v.source_url,
        partner_tier: "basic",
      }));
    if (rows.length) {
      await admin.from("venues").upsert(rows, { onConflict: "yelp_id" });
    }
  } catch {
    // Non-fatal — results still return below.
  }

  return jsonResponse({
    venues: venues.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0)),
    searchedRadiusMiles: Math.round(radiusMeters / 1609.34 * 10) / 10,
    budget: budgetParam ?? null,
  });
});
