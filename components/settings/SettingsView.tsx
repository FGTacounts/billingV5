"use client";

import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { formatAed } from "@/lib/money";
import { fetchMonthlyTargets, type MonthlyTargets } from "@/lib/queries/targets";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { useBrandLogo } from "@/lib/hooks/useBrandLogo";
import { useDisplayCurrency } from "@/lib/hooks/useDisplayCurrency";
import { SUPPORTED_CURRENCIES, type CurrencyCode } from "@/lib/currency";
import { DEFAULT_NAV_KEYS } from "@/lib/hooks/useNavShortcuts";
import {
  REPORT_STAGE_OPTIONS,
  DEFAULT_REPORT_STAGE,
  invalidateReportStageCache,
  type ReportStage,
} from "@/lib/reportStage";
import { ACCENT_THEMES, findAccentTheme, applyAccentTheme } from "@/lib/accentThemes";
import {
  fetchZones,
  fetchZoneCountries,
  createZone,
  setDefaultZone,
  deleteZone,
  upsertZoneCountry,
  removeZoneCountry,
  type Zone,
  type ZoneCountry,
} from "@/lib/queries/zones";
import type { AppUser } from "@/lib/types/db";
import Button from "@/components/ui/Button";
import { Label, TextInput } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Badge";
import Sheet from "@/components/ui/Sheet";

// Categorized per Order Flow & Additions §6 — replaces the old flat
// Appearance/General/Users/Account tab set. Users stays Manager-only
// account management, kept alongside the four new categories rather than
// folded into one of them (removing it would be a regression).
const TABS = ["General", "Account", "Data"] as const;
const MANAGER_TABS = ["General", "Sheet View", "Data", "Users", "Account"] as const;
// Zones is Admin-only (§Global: "The admin adds zones... he can allow other
// admins and control what the manager has access to") — a Manager sees the
// same tab set as before, unchanged.
const ADMIN_TABS = ["General", "Sheet View", "Zones", "Data", "Users", "Account"] as const;

export default function SettingsView({ user }: { user: AppUser }) {
  const isAdmin = user.role === "admin";
  const tabs = isAdmin ? ADMIN_TABS : (user.role === "manager" ? MANAGER_TABS : TABS);
  const [tab, setTab] = useState<string>("General");

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-large-title font-bold mb-5">Settings</h1>
      {/* §Global: "Settings should also have sidebar tabs." A real left rail
          on desktop; the same list stays a horizontal strip on phones, where
          a side rail would eat most of the width. */}
      <div className="flex flex-col md:flex-row md:gap-8 items-start">
        <nav className="w-full md:w-48 shrink-0 flex md:flex-col gap-1.5 mb-6 md:mb-0 overflow-x-auto md:overflow-visible">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`text-left whitespace-nowrap px-3.5 py-2 rounded-card text-caption md:text-subhead font-semibold border md:border-0 transition-colors ${
                tab === t
                  ? "bg-accent text-white border-accent md:bg-accent/12 md:text-accent"
                  : "border-hairline text-secondary hover:text-primary md:hover:bg-black/[0.03] md:dark:hover:bg-white/[0.05]"
              }`}
            >
              {t}
            </button>
          ))}
        </nav>

        <div className="flex-1 min-w-0 w-full">

      {tab === "General" && <GeneralTab isManager={(user.role === "manager" || user.role === "admin")} />}
      {tab === "Sheet View" && <SheetViewTab />}
      {tab === "Zones" && isAdmin && <ZonesTab />}
      {tab === "Data" && <DataTab isManager={(user.role === "manager" || user.role === "admin")} />}
      {tab === "Users" && <UsersTab currentUser={user} />}
      {tab === "Account" && <AccountTab />}
        </div>
      </div>
    </div>
  );
}

function GeneralTab({ isManager }: { isManager: boolean }) {
  const { preferences, update, loaded } = usePreferences();
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");

  // Fast path (pre-paint inline script in layout.tsx) reads localStorage
  // synchronously so there's no flash; once the server round-trip resolves,
  // its value wins — this is what makes theme follow the user cross-device
  // instead of staying stuck to whatever a previous device set locally.
  useEffect(() => {
    if (!loaded) return;
    const next = preferences.theme ?? "system";
    setTheme(next);
    if (next === "system") {
      localStorage.removeItem("fgt-theme");
      document.documentElement.removeAttribute("data-theme");
    } else {
      localStorage.setItem("fgt-theme", next);
      document.documentElement.setAttribute("data-theme", next);
    }
  }, [loaded, preferences.theme]);

  function apply(next: "system" | "light" | "dark") {
    setTheme(next);
    if (next === "system") {
      localStorage.removeItem("fgt-theme");
      document.documentElement.removeAttribute("data-theme");
    } else {
      localStorage.setItem("fgt-theme", next);
      document.documentElement.setAttribute("data-theme", next);
    }
    update({ theme: next });
  }

  return (
    <div className="space-y-6">
      <div>
        <Label>Theme</Label>
        <div className="flex gap-2">
          {(["system", "light", "dark"] as const).map((t) => (
            <button
              key={t}
              onClick={() => apply(t)}
              className={`px-4 py-2.5 rounded-card text-subhead font-medium border ${
                theme === t ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
              }`}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <CurrencySection />

      <div>
        <Label>Quick-download format</Label>
        <div className="flex gap-2 flex-wrap">
          {([
            { key: "pdf", label: "PDF only" },
            { key: "excel", label: "Excel only" },
            { key: "both", label: "Both" },
          ] as const).map((opt) => {
            const active = (preferences.quickDownloadFormat ?? "pdf") === opt.key;
            return (
              <button
                key={opt.key}
                onClick={() => update({ quickDownloadFormat: opt.key })}
                className={`px-4 py-2.5 rounded-card text-subhead font-medium border ${
                  active ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <p className="text-caption text-secondary mt-2">
          Which download button(s) appear on each row in lists. Excel downloads stay Manager-only.
        </p>
      </div>

      <div>
        <Label>Colorful data</Label>
        <label className="flex items-center gap-2 text-subhead">
          <input
            type="checkbox"
            checked={preferences.colorfulData === true}
            onChange={(e) => update({ colorfulData: e.target.checked })}
          />
          Give each category its own color
        </label>
        <p className="text-caption text-secondary mt-2">
          Colors repeating labels — product categories, expense types — so the same thing is the same
          color everywhere. The app chrome stays neutral.
        </p>
      </div>

      <NavShortcutsSection />

      {isManager && <AccentThemeSection />}
      {isManager && <BrandLogoSection />}

      <div>
        <Label>Notifications</Label>
        <label className="flex items-center gap-2 text-subhead">
          <input
            type="checkbox"
            checked={preferences.notificationsEnabled !== false}
            onChange={(e) => update({ notificationsEnabled: e.target.checked })}
          />
          Show the notifications bell badge
        </label>
        <p className="text-caption text-secondary mt-2">
          Turns off the unread-count badge — notifications still log and the panel still opens on tap.
        </p>
      </div>

      {isManager && <ReportStageSection />}
      {isManager && <OverdueThresholdSection />}
      {isManager && <MapsKeySection />}
    </div>
  );
}

// Unlocks the Planning tab for everyone (§Next Updates: "remains hidden for
// all users until the key is inputted by the manager/admin") — the key
// itself is write-only from here; GET only ever reports whether one is
// configured, never the value, matching how the app already treats other
// secrets (Drive credentials live server-side only).
function MapsKeySection() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings/maps-key")
      .then((r) => r.json())
      .then((data) => setConfigured(!!data.configured))
      .catch(() => setConfigured(false));
  }, []);

  async function save() {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/maps-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setConfigured(true);
      setApiKey("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    await fetch("/api/settings/maps-key", { method: "DELETE" }).catch(() => {});
    setConfigured(false);
    setSaving(false);
  }

  return (
    <div>
      <Label>Google Maps API key</Label>
      <p className="text-caption text-secondary mb-2">
        Unlocks the Planning tab (route optimization) for every salesman and manager. Needs the
        Directions and Geocoding APIs enabled, with billing on.
      </p>
      {configured ? (
        <div className="flex items-center gap-2">
          <Pill tone="accent">Configured</Pill>
          <Button tier="plain" disabled={saving} onClick={remove} className="text-[--status-danger]">
            {saving ? "Removing…" : "Remove key"}
          </Button>
        </div>
      ) : (
        <div className="flex gap-2 items-center">
          <TextInput
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="AIza…"
            className="max-w-xs"
          />
          <Button tier="primary" disabled={saving || !apiKey.trim()} onClick={save}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      )}
      {error && <div className="mt-2 text-caption text-[--status-danger]">{error}</div>}
    </div>
  );
}

function OverdueThresholdSection() {
  const [settingsId, setSettingsId] = useState<number | null>(null);
  const [days, setDays] = useState("90");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    supabaseBrowser()
      .from("app_settings")
      .select("id, overdue_threshold_days")
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setSettingsId(data.id);
          setDays(String(data.overdue_threshold_days));
        }
      });
  }, []);

  async function save() {
    if (settingsId == null) return;
    await supabaseBrowser()
      .from("app_settings")
      .update({ overdue_threshold_days: Number(days) })
      .eq("id", settingsId);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div>
      <Label>Overdue threshold (days)</Label>
      <div className="flex gap-2 items-center">
        <TextInput type="number" value={days} onChange={(e) => setDays(e.target.value)} className="max-w-[120px]" />
        <Button tier="primary" disabled={settingsId == null} onClick={save}>{saved ? "Saved" : "Save"}</Button>
      </div>
      <p className="text-caption text-secondary mt-2">
        Global — feeds the Bad/overdue condition tag and credit-hold warning across all customers.
      </p>
    </div>
  );
}

// §Global: "Admin can adjust at what point of the order/payment flow orders
// affect reports." Applies app-wide (dashboard totals, sales, aging,
// statements, product insights) — they all read the same threshold.
function ReportStageSection() {
  const [stage, setStage] = useState<ReportStage | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabaseBrowser()
      .from("app_settings")
      .select("reports_from_status")
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) { setUnsupported(true); return; }
        setStage((data?.reports_from_status as ReportStage) ?? DEFAULT_REPORT_STAGE);
      });
  }, []);

  async function save(next: ReportStage) {
    setSaving(true);
    const prev = stage;
    setStage(next);
    const supabase = supabaseBrowser();
    const { data: row } = await supabase.from("app_settings").select("id").limit(1).maybeSingle();
    const { error } = await supabase
      .from("app_settings")
      .update({ reports_from_status: next })
      .eq("id", row?.id ?? 1);
    if (error) {
      setStage(prev);
      toast.error("This setting isn't available on your account yet. Ask your administrator to enable it.");
    } else {
      invalidateReportStageCache();
    }
    setSaving(false);
  }

  if (unsupported) {
    return (
      <div>
        <Label>Reports count an order from</Label>
        <p className="text-caption text-secondary">
          Not available yet — needs the <code>reports_from_status</code> column added first.
        </p>
      </div>
    );
  }

  return (
    <div>
      <Label>Reports count an order from</Label>
      <div className="flex flex-col gap-2">
        {REPORT_STAGE_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`flex items-start gap-2.5 px-3.5 py-2.5 rounded-card border cursor-pointer transition-colors ${
              stage === opt.value ? "border-accent bg-accent/[0.06]" : "border-hairline"
            }`}
          >
            <input
              type="radio"
              name="report-stage"
              className="mt-1"
              checked={stage === opt.value}
              disabled={saving || stage === null}
              onChange={() => save(opt.value)}
            />
            <span>
              <span className="text-subhead font-medium block">{opt.label}</span>
              <span className="text-caption text-secondary">{opt.hint}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="text-caption text-secondary mt-2">
        Applies everywhere at once — dashboard totals, sales, customer aging, statements and product
        insights all use this threshold.
      </p>
    </div>
  );
}

// §Global: "add shortcuts for app navigation — disabled by default, but
// allow setting custom shortcuts or choosing default shortcuts." Press g,
// then the key. Each route's key is editable; blank falls back to default.
function NavShortcutsSection() {
  const { preferences, update } = usePreferences();
  const enabled = preferences.navShortcutsEnabled === true;
  const custom = preferences.navShortcutKeys ?? {};

  const ROUTES: { href: string; label: string }[] = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/orders", label: "Orders" },
    { href: "/customers", label: "Customers" },
    { href: "/products", label: "Products" },
    { href: "/sales", label: "Sales" },
    { href: "/payments", label: "Payments" },
    { href: "/invoices", label: "Invoices" },
    { href: "/reports", label: "Reports" },
    { href: "/expense", label: "Expense" },
    { href: "/settings", label: "Settings" },
  ];

  return (
    <div>
      <Label>Keyboard shortcuts</Label>
      <label className="flex items-center gap-2 text-subhead">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => update({ navShortcutsEnabled: e.target.checked })}
        />
        Enable navigation shortcuts
      </label>
      <p className="text-caption text-secondary mt-2">
        Press <kbd className="px-1.5 py-0.5 rounded border border-hairline text-caption">g</kbd> then the
        key below. Ignored while you&rsquo;re typing in a field.
      </p>

      {enabled && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {ROUTES.map((r) => (
            <div key={r.href} className="flex items-center justify-between gap-2 px-3 py-2 rounded-card border border-hairline">
              <span className="text-subhead truncate">{r.label}</span>
              <input
                value={custom[r.href] ?? DEFAULT_NAV_KEYS[r.href] ?? ""}
                maxLength={1}
                onChange={(e) =>
                  update({
                    navShortcutKeys: { ...custom, [r.href]: e.target.value.toLowerCase() },
                  })
                }
                className="w-9 text-center px-1 py-1 rounded-inner border border-hairline bg-canvas text-caption font-semibold uppercase"
                aria-label={`Shortcut key for ${r.label}`}
              />
            </div>
          ))}
        </div>
      )}

      {enabled && Object.keys(custom).length > 0 && (
        <div className="mt-2">
          <Button tier="plain" onClick={() => update({ navShortcutKeys: {} })}>
            Reset to defaults
          </Button>
        </div>
      )}
    </div>
  );
}

// Per-user display currency (§Global: "Users can change the currency in the
// settings. Prices change automatically according to latest currency
// prices") — everything is still stored/invoiced in AED; this only changes
// what figure a user sees on screen, converted live via useDisplayCurrency.
function CurrencySection() {
  const { currency, setCurrency } = useDisplayCurrency();

  return (
    <div>
      <Label>Display currency</Label>
      <select
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead"
        value={currency}
        onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
      >
        {SUPPORTED_CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>{c.code} — {c.label}</option>
        ))}
      </select>
      <p className="text-caption text-secondary mt-2">
        Converts figures on screen using live exchange rates — everything is still recorded and invoiced in AED.
      </p>
    </div>
  );
}

// Manager-only app-wide accent color (§Next Updates: "don't copy the color
// theme, allow the manager to change it for all users") — same
// id-then-update pattern as OverdueThresholdSection, applied to every
// signed-in user via AccentThemeLoader.
function AccentThemeSection() {
  const [settingsId, setSettingsId] = useState<number | null>(null);
  const [activeKey, setActiveKey] = useState("green");
  const [saving, setSaving] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  useEffect(() => {
    supabaseBrowser()
      .from("app_settings")
      .select("id, accent_theme")
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          setUnsupported(true);
          return;
        }
        if (data) {
          setSettingsId(data.id);
          setActiveKey(findAccentTheme(data.accent_theme).key);
        }
      });
  }, []);

  async function choose(key: string) {
    if (settingsId == null) return;
    setSaving(key);
    const { error } = await supabaseBrowser()
      .from("app_settings")
      .update({ accent_theme: key })
      .eq("id", settingsId);
    setSaving(null);
    if (error) {
      toast.error("The app colour couldn't be saved. Ask your administrator to enable it.");
      return;
    }
    setActiveKey(key);
    const theme = findAccentTheme(key);
    applyAccentTheme(theme);
    try {
      localStorage.setItem("fgt-accent-theme", theme.key);
    } catch {}
  }

  return (
    <div>
      <Label>App theme (all users)</Label>
      <div className="flex gap-2 flex-wrap">
        {ACCENT_THEMES.map((t) => (
          <button
            key={t.key}
            onClick={() => choose(t.key)}
            disabled={settingsId == null || unsupported}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-card text-subhead font-medium border disabled:opacity-40 ${
              activeKey === t.key ? "border-accent" : "border-hairline"
            }`}
          >
            <span
              className="w-4 h-4 rounded-full shrink-0"
              style={{ background: t.accent }}
            />
            {saving === t.key ? "Saving…" : t.label}
          </button>
        ))}
      </div>
      <p className="text-caption text-secondary mt-3">
        {unsupported
          ? "Not available on your account yet — ask your administrator to enable it."
          : "Changes the accent color for every user's app, not just yours."}
      </p>
    </div>
  );
}

// Admin-uploaded logo (§Global: "Users can upload their own logo. Syncs
// with all data") — one fixed Storage path, so the Sidebar and invoice
// PDFs all pick it up with no per-user setting to keep in sync.
function BrandLogoSection() {
  const { url: logoUrl, loaded } = useBrandLogo();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/settings/brand-logo", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setPreviewKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    setUploading(true);
    setError(null);
    try {
      await fetch("/api/settings/brand-logo", { method: "DELETE" });
      setPreviewKey((k) => k + 1);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <Label>Logo (all users)</Label>
      <div className="flex items-center gap-4">
        <div className="w-20 h-20 rounded-card border border-hairline bg-surface grid place-items-center overflow-hidden shrink-0">
          {loaded && (
            // eslint-disable-next-line @next/next/no-img-element -- live preview of an uploaded asset
            <img key={previewKey} src={logoUrl} alt="Logo preview" className="max-w-full max-h-full object-contain" />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <label>
              <input
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) upload(file);
                  e.target.value = "";
                }}
              />
              <span className="inline-block">
                <Button tier="tinted" disabled={uploading}>
                  {uploading ? "Uploading…" : "Upload logo"}
                </Button>
              </span>
            </label>
            <Button tier="plain" disabled={uploading} onClick={remove}>
              Reset to default
            </Button>
          </div>
          <p className="text-caption text-secondary">PNG or JPEG, under 5MB. Applies to the sidebar and invoice PDFs for every user.</p>
          {error && <p className="text-caption text-[--status-danger]">{error}</p>}
        </div>
      </div>
    </div>
  );
}

// Admin-only (§Global: "The admin adds zones. For each zone he can set
// specific data entries such as vat for that specific zone. And all the
// countries that are linked to that zone follow this. By default it is in
// one zone. He can set the currency for each specific country, or just use
// a general currency for that zone.") — needs the zones/zone_countries
// tables from scratchpad/zones-and-payer-details-migration.sql; degrades to
// an explanatory message until that's run.
function ZonesTab() {
  const [zones, setZones] = useState<Zone[]>([]);
  const [countries, setCountries] = useState<ZoneCountry[]>([]);
  const [unsupported, setUnsupported] = useState(false);
  const [loading, setLoading] = useState(true);

  const [newZoneName, setNewZoneName] = useState("");
  const [newZoneVat, setNewZoneVat] = useState("15");
  const [newZoneCurrency, setNewZoneCurrency] = useState("AED");
  const [savingZone, setSavingZone] = useState(false);

  const [countryCode, setCountryCode] = useState("");
  const [countryName, setCountryName] = useState("");
  const [countryZoneId, setCountryZoneId] = useState("");
  const [countryCurrency, setCountryCurrency] = useState("");
  const [savingCountry, setSavingCountry] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = supabaseBrowser();
    const [z, c] = await Promise.all([fetchZones(supabase), fetchZoneCountries(supabase)]);
    setZones(z);
    setCountries(c);
    setUnsupported(z.length === 0 && c.length === 0);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!countryZoneId && zones.length > 0) setCountryZoneId(zones.find((z) => z.is_default)?.id ?? zones[0].id);
  }, [zones, countryZoneId]);

  async function addZone() {
    if (!newZoneName.trim()) return;
    setSavingZone(true);
    try {
      await createZone(supabaseBrowser(), {
        name: newZoneName.trim(),
        vat_rate: (Number(newZoneVat) || 0) / 100,
        currency_code: newZoneCurrency.trim().toUpperCase() || "AED",
      });
      setNewZoneName("");
      setNewZoneVat("15");
      setNewZoneCurrency("AED");
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "Failed to add zone"));
    } finally {
      setSavingZone(false);
    }
  }

  async function makeDefault(id: string) {
    await setDefaultZone(supabaseBrowser(), id);
    load();
  }

  async function removeZone(id: string) {
    if (!confirm("Remove this zone? Countries mapped to it will need to be reassigned.")) return;
    try {
      await deleteZone(supabaseBrowser(), id);
      load();
    } catch (e) {
      toast.error(friendlyError(e, "Failed to remove zone — reassign its countries first."));
    }
  }

  async function addCountry() {
    if (!countryCode.trim() || !countryName.trim() || !countryZoneId) return;
    setSavingCountry(true);
    try {
      await upsertZoneCountry(supabaseBrowser(), {
        country_code: countryCode.trim().toUpperCase(),
        country_name: countryName.trim(),
        zone_id: countryZoneId,
        currency_code: countryCurrency.trim() ? countryCurrency.trim().toUpperCase() : null,
      });
      setCountryCode("");
      setCountryName("");
      setCountryCurrency("");
      await load();
    } catch (e) {
      toast.error(friendlyError(e, "Failed to add country"));
    } finally {
      setSavingCountry(false);
    }
  }

  async function removeCountry(code: string) {
    await removeZoneCountry(supabaseBrowser(), code);
    load();
  }

  if (loading) return <p className="text-caption text-secondary">Loading…</p>;

  if (unsupported) {
    return (
      <p className="text-caption text-secondary">
        Not available yet — needs the zones tables added to the database first.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Label>Zones</Label>
        <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline mb-3">
          {zones.map((z) => (
            <div key={z.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-subhead font-medium flex items-center gap-2">
                  {z.name}
                  {z.is_default && <Pill tone="accent">Default</Pill>}
                </div>
                <div className="text-caption text-secondary">
                  VAT {Math.round(z.vat_rate * 100)}% · {z.currency_code}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!z.is_default && (
                  <Button tier="plain" onClick={() => makeDefault(z.id)}>Make default</Button>
                )}
                <Button tier="plain" className="text-[--status-danger]" onClick={() => removeZone(z.id)}>
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex-1 min-w-[140px]">
            <Label>Zone name</Label>
            <TextInput value={newZoneName} onChange={(e) => setNewZoneName(e.target.value)} placeholder="e.g. GCC" />
          </div>
          <div className="w-24">
            <Label>VAT %</Label>
            <TextInput type="number" value={newZoneVat} onChange={(e) => setNewZoneVat(e.target.value)} />
          </div>
          <div className="w-24">
            <Label>Currency</Label>
            <TextInput value={newZoneCurrency} onChange={(e) => setNewZoneCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </div>
          <Button tier="primary" disabled={savingZone || !newZoneName.trim()} onClick={addZone}>
            {savingZone ? "Adding…" : "Add zone"}
          </Button>
        </div>
      </div>

      <div>
        <Label>Countries</Label>
        <p className="text-caption text-secondary mb-2">
          A country not listed here uses the Default zone's VAT and currency.
        </p>
        {countries.length > 0 && (
          <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline mb-3">
            {countries.map((c) => {
              const zone = zones.find((z) => z.id === c.zone_id);
              return (
                <div key={c.country_code} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-subhead font-medium">{c.country_name} ({c.country_code})</div>
                    <div className="text-caption text-secondary">
                      {zone?.name ?? "—"} · {c.currency_code ?? `${zone?.currency_code ?? "AED"} (zone default)`}
                    </div>
                  </div>
                  <Button tier="plain" className="text-[--status-danger]" onClick={() => removeCountry(c.country_code)}>
                    Remove
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex gap-2 flex-wrap items-end">
          <div className="w-20">
            <Label>Code</Label>
            <TextInput value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} placeholder="AE" maxLength={2} />
          </div>
          <div className="flex-1 min-w-[120px]">
            <Label>Country name</Label>
            <TextInput value={countryName} onChange={(e) => setCountryName(e.target.value)} placeholder="United Arab Emirates" />
          </div>
          <div className="min-w-[140px]">
            <Label>Zone</Label>
            <select
              className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead"
              value={countryZoneId}
              onChange={(e) => setCountryZoneId(e.target.value)}
            >
              {zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </div>
          <div className="w-28">
            <Label>Currency override</Label>
            <TextInput value={countryCurrency} onChange={(e) => setCountryCurrency(e.target.value.toUpperCase())} placeholder="Zone default" maxLength={3} />
          </div>
          <Button tier="primary" disabled={savingCountry || !countryCode.trim() || !countryName.trim()} onClick={addCountry}>
            {savingCountry ? "Adding…" : "Add country"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Manager-only (§6/§7): whether downloaded sheets (order exports, bulk
// data) list items in plain article order, or separate marked/picked items
// from unmarked ones — useful for picking-related exports specifically.
function SheetViewTab() {
  const { preferences, update } = usePreferences();
  const separateMarked = preferences.downloadSeparateMarked ?? false;

  return (
    <div>
      <Label>Download order</Label>
      <div className="flex gap-2">
        <button
          onClick={() => update({ downloadSeparateMarked: false })}
          className={`px-4 py-2.5 rounded-card text-subhead font-medium border ${
            !separateMarked ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
          }`}
        >
          Article order
        </button>
        <button
          onClick={() => update({ downloadSeparateMarked: true })}
          className={`px-4 py-2.5 rounded-card text-subhead font-medium border ${
            separateMarked ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
          }`}
        >
          Separate marked/unmarked
        </button>
      </div>
      <p className="text-caption text-secondary mt-3">
        Applies to downloaded order sheets — useful when what's been picked vs. not matters more
        than raw article order.
      </p>
    </div>
  );
}

// All roles (§6): bulk "Download All" for each data type — Excel for
// Manager, PDF for everyone else, the same export-format rule already
// applied everywhere else in the app, just generalized beyond Invoices.
function DataTab({ isManager }: { isManager: boolean }) {
  const types: { key: string; label: string }[] = [
    { key: "customers", label: "Customers" },
    { key: "products", label: "Products" },
    { key: "orders", label: "Orders" },
  ];
  const endpoint = isManager ? "/api/export/excel" : "/api/export/pdf";
  return (
    <div className="space-y-3">
      {types.map((t) => (
        <a
          key={t.key}
          href={`${endpoint}?type=${t.key}`}
          target={isManager ? undefined : "_blank"}
          rel="noreferrer"
          className="flex items-center justify-between px-4 py-3.5 rounded-card border border-hairline hover:border-accent/50 transition"
        >
          <span className="text-subhead font-medium">Download all {t.label}</span>
          <span className="flex items-center gap-1.5 text-caption font-semibold text-accent">
            <Download size={14} /> {isManager ? "Excel" : "PDF"}
          </span>
        </a>
      ))}
    </div>
  );
}

function UsersTab({ currentUser }: { currentUser: AppUser }) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<AppUser | null>(null);
  // Monthly sales goals, shown against each salesman. Fetched separately so
  // a pre-migration database (no monthly_target column) still lists users.
  const [targets, setTargets] = useState<MonthlyTargets | null>(null);
  const [targetsSupported, setTargetsSupported] = useState(true);

  async function load() {
    const supabase = supabaseBrowser();
    const { data } = await supabase
      .from("users")
      .select("id, auth_user_id, username, full_name, role, email, is_active, created_at, updated_at")
      .order("full_name");
    setUsers((data as AppUser[]) ?? []);

    const probe = await supabase.from("users").select("monthly_target").limit(1);
    setTargetsSupported(!probe.error);
    if (!probe.error) setTargets(await fetchMonthlyTargets(supabase));
  }

  async function saveTarget(userId: string, value: string) {
    const trimmed = value.trim();
    const target = trimmed === "" ? null : Number(trimmed);
    if (target !== null && (!Number.isFinite(target) || target < 0)) {
      toast.error("Enter a goal of zero or more, or leave it blank to use the company default.");
      return;
    }
    const { error } = await supabaseBrowser()
      .from("users")
      .update({ monthly_target: target })
      .eq("id", userId);
    if (error) {
      toast.error(friendlyError(error, "Couldn't save the goal."));
      return;
    }
    toast.success(target === null ? "Goal cleared — using the company default." : "Goal saved.");
    load();
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Button tier="primary" onClick={() => setShowNew(true)}>Add user</Button>
      </div>
      <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
        {users.map((u) => (
          <div
            key={u.id}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
          >
            <button onClick={() => setEditing(u)} className="flex-1 min-w-0 text-left">
              <div className="text-subhead font-medium truncate">{u.full_name}</div>
              <div className="text-caption text-secondary truncate">@{u.username} · {u.role}</div>
            </button>
            {targetsSupported && u.role === "salesman" && (
              <label className="flex items-center gap-2 shrink-0">
                <span className="text-caption text-secondary hidden sm:inline">Monthly goal</span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  defaultValue={targets?.byUser.get(u.id) ?? ""}
                  placeholder={String(targets?.fallback ?? "")}
                  onBlur={(e) => saveTarget(u.id, e.target.value)}
                  className="w-28 px-3 py-1.5 rounded-chip border border-hairline bg-canvas text-subhead tabular-nums text-right"
                  title="Leave blank to use the company default"
                />
              </label>
            )}
            <Pill tone={u.is_active ? "accent" : "danger"}>{u.is_active ? "Active" : "Deactivated"}</Pill>
          </div>
        ))}
      </div>

      {targetsSupported ? (
        <p className="text-caption text-secondary mt-2">
          Leave a goal blank to use the company default of{" "}
          {formatAed(targets?.fallback ?? 0)}. Goals drive every &ldquo;% to
          goal&rdquo; figure on the Dashboard and Sales pages.
        </p>
      ) : (
        <p className="text-caption text-secondary mt-2">
          Individual sales goals aren&rsquo;t enabled on your account yet, so every
          salesman is currently measured against the same company goal. Ask your
          administrator to turn this on.
        </p>
      )}

      {showNew && (
        <UserEditor
          isCallerAdmin={currentUser.role === "admin"}
          onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); load(); }}
        />
      )}
      {editing && (
        <UserEditor
          user={editing}
          isSelf={editing.id === currentUser.id}
          isCallerAdmin={currentUser.role === "admin"}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function UserEditor({
  user,
  isSelf = false,
  isCallerAdmin,
  onClose,
  onSaved,
}: {
  user?: AppUser;
  isSelf?: boolean;
  isCallerAdmin: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [username, setUsername] = useState(user?.username ?? "");
  const [name, setName] = useState(user?.full_name ?? "");
  const [role, setRole] = useState(user?.role ?? "salesman");
  const [active, setActive] = useState(user?.is_active ?? true);
  const [password, setPassword] = useState("");
  // Admin is above Manager (§Global) — a Manager can view but not edit an
  // existing Admin's account, and can't grant Admin access to anyone.
  const targetIsAdmin = user?.role === "admin";
  const readOnly = targetIsAdmin && !isCallerAdmin && !isSelf;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      if (user) {
        const res = await fetch(`/api/admin/users/${user.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, role, active, password: password || undefined }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
      } else {
        const res = await fetch("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, name, password, role }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!user) return;
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove user");
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={user ? "Edit user" : "Add user"}
      footer={
        <>
          {user && !isSelf && !readOnly && (
            confirmRemove ? (
              <>
                <Button tier="plain" onClick={() => setConfirmRemove(false)}>Never mind</Button>
                <Button tier="danger" disabled={removing} onClick={remove}>
                  {removing ? "Removing…" : "Confirm remove"}
                </Button>
              </>
            ) : (
              <Button tier="plain" onClick={() => setConfirmRemove(true)} className="text-[--status-danger] mr-auto">
                Remove user
              </Button>
            )
          )}
          {!confirmRemove && (
            <>
              <Button tier="plain" onClick={onClose}>{readOnly ? "Close" : "Cancel"}</Button>
              {!readOnly && (
                <Button tier="primary" disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
              )}
            </>
          )}
        </>
      }
    >
      {!user && (
        <>
          <Label>Username</Label>
          <TextInput value={username} onChange={(e) => setUsername(e.target.value)} disabled={readOnly} autoCapitalize="none" />
        </>
      )}
      <Label>Full name</Label>
      <TextInput value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} />
      <Label>Role</Label>
      <select
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead disabled:opacity-50"
        value={role}
        disabled={isSelf || readOnly}
        onChange={(e) => setRole(e.target.value as AppUser["role"])}
      >
        <option value="salesman">Salesman</option>
        <option value="manager">Manager</option>
        <option value="warehouse">Warehouse</option>
        {(isCallerAdmin || targetIsAdmin) && <option value="admin">Admin</option>}
      </select>
      <Label>{user ? "Reset password (optional)" : "Password"}</Label>
      <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={readOnly} />
      {user && !isSelf && (
        <label className="flex items-center gap-2 mt-4 text-subhead">
          <input type="checkbox" checked={active} disabled={readOnly} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
      )}
      {isSelf && (
        <p className="text-caption text-secondary mt-4">
          You can't deactivate, remove, or change the role of your own account.
        </p>
      )}
      {readOnly && (
        <p className="text-caption text-secondary mt-4">
          Only an Admin can edit another Admin's account.
        </p>
      )}
      {error && <div className="mt-3 text-caption text-[--status-danger]">{error}</div>}
    </Sheet>
  );
}

function AccountTab() {
  const router = useRouter();
  const [linking, setLinking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [contactLoaded, setContactLoaded] = useState(false);
  const [savingContact, setSavingContact] = useState(false);
  const [contactSaved, setContactSaved] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);

  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/account")
      .then((r) => r.json())
      .then((data) => {
        setEmail(data.email ?? "");
        setPhone(data.phone ?? "");
      })
      .finally(() => setContactLoaded(true));
  }, []);

  async function saveContact() {
    setSavingContact(true);
    setContactError(null);
    try {
      const res = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() || null, phone: phone.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      setContactSaved(true);
      setTimeout(() => setContactSaved(false), 2000);
    } catch (e) {
      setContactError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSavingContact(false);
    }
  }

  async function changePassword() {
    if (!newPassword) return;
    setSavingPassword(true);
    setPasswordError(null);
    try {
      const { error } = await supabaseBrowser().auth.updateUser({ password: newPassword });
      if (error) throw error;
      setNewPassword("");
      setPasswordSaved(true);
      setTimeout(() => setPasswordSaved(false), 2000);
    } catch (e) {
      setPasswordError(e instanceof Error ? e.message : "Failed to change password");
    } finally {
      setSavingPassword(false);
    }
  }

  async function linkGoogle() {
    setLinking(true);
    try {
      const { error } = await supabaseBrowser().auth.linkIdentity({ provider: "google" });
      if (error) throw error;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed to link Google account");
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Label>Email</Label>
        <TextInput
          type="email"
          value={email}
          disabled={!contactLoaded}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
        <Label>Phone</Label>
        <TextInput
          type="tel"
          value={phone}
          disabled={!contactLoaded}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="050 000 0000"
        />
        <div className="flex items-center gap-2 mt-2">
          <Button tier="primary" disabled={savingContact || !contactLoaded} onClick={saveContact}>
            {savingContact ? "Saving…" : contactSaved ? "Saved" : "Save contact info"}
          </Button>
        </div>
        {contactError && <div className="mt-2 text-caption text-[--status-danger]">{contactError}</div>}
        <p className="text-caption text-secondary mt-2">
          This email can also be used to log in, alongside your username.
        </p>
      </div>

      <div>
        <Label>Change password</Label>
        <TextInput
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder="New password"
        />
        <div className="flex items-center gap-2 mt-2">
          <Button tier="primary" disabled={savingPassword || !newPassword} onClick={changePassword}>
            {savingPassword ? "Saving…" : passwordSaved ? "Saved" : "Change password"}
          </Button>
        </div>
        {passwordError && <div className="mt-2 text-caption text-[--status-danger]">{passwordError}</div>}
      </div>

      <div>
        <Label>Sign-in options</Label>
        <Button tier="tinted" disabled={linking} onClick={linkGoogle}>
          {linking ? "Opening Google…" : "Link Google account"}
        </Button>
        {message && <div className="mt-2 text-caption text-[--status-danger]">{message}</div>}
      </div>

      <div>
        <Label>Session</Label>
        <Button tier="danger" onClick={logout}>Log out</Button>
      </div>
    </div>
  );
}
