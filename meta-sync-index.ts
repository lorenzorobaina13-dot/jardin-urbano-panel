// meta-sync: trae inversión, leads, impresiones y clics de Meta Ads al panel (tabla entries)
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* sin body */ }

  // Autorización: usuario logueado del panel o la tarea diaria (cron_key)
  let ok = false;
  if (body.cron_key) {
    const { data } = await admin.from("app_config").select("value").eq("key", "cron_key").maybeSingle();
    ok = !!data && data.value === body.cron_key;
  }
  const tok = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!ok && tok) {
    const { data } = await admin.auth.getUser(tok);
    ok = !!data?.user;
  }
  if (!ok) return json({ error: "No autorizado" }, 401);

  const TOKEN = Deno.env.get("META_ACCESS_TOKEN");
  if (!TOKEN) return json({ error: "Falta el secret META_ACCESS_TOKEN en Supabase" }, 500);
  const V = Deno.env.get("META_API_VERSION") || "v23.0";
  const G = `https://graph.facebook.com/${V}`;
  const get = async (url: string) => {
    const r = await fetch(url);
    const j = await r.json();
    if (j.error) throw new Error("Meta: " + j.error.message);
    return j;
  };
  const all = async (url: string) => {
    let out: any[] = [];
    let next: string | null = url;
    let guard = 0;
    while (next && guard++ < 60) {
      const j = await get(next);
      out = out.concat(j.data || []);
      next = j.paging?.next || null;
    }
    return out;
  };

  try {
    // Cuentas: la del secret META_AD_ACCOUNT_ID, o todas las que ve el token
    const envAcc = Deno.env.get("META_AD_ACCOUNT_ID");
    let accounts: string[] = envAcc
      ? envAcc.split(",").map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith("act_") ? s : "act_" + s))
      : (await all(`${G}/me/adaccounts?fields=id,name&limit=100&access_token=${TOKEN}`)).map((a: any) => a.id);
    if (!accounts.length) return json({ error: "El token no tiene acceso a ninguna cuenta publicitaria" }, 400);

    const days = Math.min(Math.max(parseInt(body.days) || 30, 1), 365);
    const ymd = (x: Date) => x.toISOString().slice(0, 10);
    const tr = encodeURIComponent(JSON.stringify({ since: ymd(new Date(Date.now() - (days - 1) * 864e5)), until: ymd(new Date()) }));
    const fields = "campaign_id,campaign_name,spend,impressions,clicks,actions";
    let rows: any[] = [];
    for (const a of accounts) {
      rows = rows.concat(await all(`${G}/${a}/insights?level=campaign&time_increment=1&time_range=${tr}&fields=${fields}&limit=500&access_token=${TOKEN}`));
    }

    // Qué campaña de Meta va a qué proyecto: palabras en "meta_match" del proyecto
    const { data: projects, error: pe } = await admin.from("projects").select("id,name,meta_match").eq("type", "campaign");
    if (pe) throw pe;
    const matchers = (projects || [])
      .map((p: any) => ({ id: p.id, keys: String(p.meta_match || "").split(",").map(norm).filter(Boolean) }))
      .filter((p) => p.keys.length);

    const act = (acts: any[], t: string) => Number((acts || []).find((x: any) => x.action_type === t)?.value || 0);
    const agg = new Map<string, any>();
    const unmatched = new Set<string>();
    for (const r of rows) {
      const n = norm(r.campaign_name);
      const p = matchers.find((m) => m.keys.some((k) => n.includes(k)));
      if (!p) { unmatched.add(r.campaign_name); continue; }
      const key = p.id + "|" + r.date_start;
      const c = agg.get(key) || { project_id: p.id, fecha: r.date_start, inversion: 0, form: 0, imp: 0, clics: 0, camps: new Set<string>(), pc: {} as Record<string, any> };
      c.inversion += Number(r.spend || 0);
      c.imp += Number(r.impressions || 0);
      c.clics += Number(r.clicks || 0);
      // Leads = "Clientes potenciales en el sitio web" (formularios de GHL medidos con el píxel)
      const leads = act(r.actions, "offsite_conversion.fb_pixel_lead") || act(r.actions, "lead");
      c.form += leads;
      c.camps.add(r.campaign_name);
      const pc = c.pc[r.campaign_name] || (c.pc[r.campaign_name] = { inversion: 0, leads: 0, impresiones: 0, clics: 0 });
      pc.inversion = Math.round((pc.inversion + Number(r.spend || 0)) * 100) / 100;
      pc.leads += leads;
      pc.impresiones += Number(r.impressions || 0);
      pc.clics += Number(r.clicks || 0);
      agg.set(key, c);
    }
    const up = [...agg.values()].map((c) => ({
      project_id: c.project_id, fecha: c.fecha, source: "meta", label: "Meta Ads",
      note: [...c.camps].join(", ").slice(0, 300),
      vals: { inversion: Math.round(c.inversion * 100) / 100, leads: c.form, impresiones: c.imp, clics: c.clics, por_campana: c.pc },
    }));
    if (up.length) {
      const { error } = await admin.from("entries").upsert(up, { onConflict: "project_id,source,fecha" });
      if (error) throw error;
    }
    await admin.from("app_config").upsert({ key: "meta_last_sync", value: new Date().toISOString() });
    return json({ ok: true, cuentas: accounts, dias: days, filas_meta: rows.length, registros: up.length, sin_asignar: [...unmatched] });
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
