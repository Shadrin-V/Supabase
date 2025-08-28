// deno-lint-ignore-file no-explicit-any
// Edge Function: берет INSERT из таблицы leads и делает upsert контакта в GHL.

function normalizePhone(p?: string | null) {
  if (!p) return undefined;
  const d = p.replace(/[^\d+]/g, "");
  return d.startsWith("+") ? d : `+${d}`;
}
function pick(v: any) { return v === "" || v === null ? undefined : v; }

async function upsertToGHL(lead: any) {
  const locationId = Deno.env.get("GHL_LOCATION_ID");
  if (!locationId) throw new Error("Missing GHL_LOCATION_ID env");

  // ⚠️ Подгони эти поля под СВОИ названия колонок в таблице `leads`
  const firstName = pick(lead.first_name ?? lead.firstname ?? lead.firstName);
  const lastName  = pick(lead.last_name  ?? lead.lastname  ?? lead.lastName);
  const name      = pick(lead.name);
  const email     = pick(lead.email);
  const phone     = normalizePhone(pick(lead.phone ?? lead.phone_number));
  const source    = pick(lead.source) ?? "Supabase";

  if (!email && !phone) throw new Error("Validation: need at least email or phone");

  const body: any = {
    locationId,
    firstName,
    lastName,
    name,
    email,
    phone,
    source,
    // Пример: кастом-поля (если добавишь ID полей из GHL в секреты проекта):
    // customFields: [
    //   { id: Deno.env.get("CF_SERVICE_ID")!, value: pick(lead.service) ?? "" },
    //   { id: Deno.env.get("CF_UTM_SOURCE_ID")!, value: pick(lead.utm_source) ?? "" },
    // ],
  };

  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  console.log("ghlRequest:", JSON.stringify(body));

  let lastErr: string | undefined;
  for (const delay of [0, 600, 1500]) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    const r = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${Deno.env.get("GHL_TOKEN")}`,
        "Version": Deno.env.get("GHL_VERSION") || "2021-07-28",
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    console.log(`ghlStatus: ${r.status}`, "ghlResponse:", text);
    if (r.ok) {
      try { return JSON.parse(text || "{}"); } catch { return { raw: text }; }
    }
    if (![429,500,502,503,504].includes(r.status)) {
      throw new Error(`GHL ${r.status}: ${text}`);
    }
    lastErr = `GHL ${r.status}: ${text}`;
  }
  throw new Error(lastErr);
}

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const expected = Deno.env.get("WEBHOOK_SECRET");
    if (expected && req.headers.get("x-webhook-secret") !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload = await req.json();
    if (payload?.type !== "INSERT" || !payload?.record) {
      console.log("Ignored payload:", JSON.stringify(payload));
      return new Response("Ignored", { status: 200 });
    }

    const result = await upsertToGHL(payload.record);
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("ERROR:", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
