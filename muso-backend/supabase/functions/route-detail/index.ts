// GET /route-detail?routeId=...
//
// Returns a route and its ordered stops for the itinerary reveal UI.
// Mystery stops (is_mystery = true) have their name/description masked
// until check-in, mirroring the "Unknown Location" behavior on the
// landing page demo.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAsUser } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const routeId = url.searchParams.get("routeId");
  if (!routeId) {
    return jsonResponse({ error: "routeId is required" }, 400);
  }

  let client;
  try {
    client = getSupabaseAsUser(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  const { data: route, error: routeErr } = await client
    .from("routes")
    .select("id, title, description, twist_key, stop_count_options, is_sponsored")
    .eq("id", routeId)
    .single();

  if (routeErr || !route) {
    return jsonResponse({ error: routeErr?.message ?? "Route not found" }, 404);
  }

  const { data: stops, error: stopsErr } = await client
    .from("route_stops")
    .select("id, stop_order, name, description, emoji, is_mystery")
    .eq("route_id", routeId)
    .order("stop_order", { ascending: true });

  if (stopsErr) {
    return jsonResponse({ error: stopsErr.message }, 400);
  }

  const itinerary = (stops ?? []).map((s: Record<string, unknown>) =>
    s.is_mystery
      ? { ...s, name: "Unknown Location", description: "We pick. You don't find out until you arrive." }
      : s,
  );

  return jsonResponse({ route, stops: itinerary });
});
