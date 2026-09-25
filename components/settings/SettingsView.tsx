"use client";

import { toast } from "@/lib/toast";
import { DELIVERY_STEP_DEFAULT, setDeliveryEnabled } from "@/lib/deliveryStep";
import {
  APPROVALS_DEFAULT,
  approvalSettingsSupported,
  fetchApprovalSettings,
  setApprovalNeeded,
  type ApprovalKey,
  type ApprovalSettings,
} from "@/lib/approvals";
import { friendlyError } from "@/lib/errors";
import { formatAed } from "@/lib/money";
import { fetchMonthlyTargets, saveIncentive, type MonthlyTargets } from "@/lib/queries/targets";
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { useBrandLogo, refreshBrandLogo } from "@/lib/hooks/useBrandLogo";
import { useAvatar, refreshAvatar, initialsOf } from "@/lib/hooks/useAvatar";
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
import { navFor, primaryNavFor, MAX_PRIMARY_NAV } from "@/lib/nav";
import Button from "@/components/ui/Button";
import { Label, TextInput } from "@/components/ui/Field";
import { Pill } from "@/components/ui/Badge";
import Sheet from "@/components/ui/Sheet";
import DataGrid from "./DataGrid";
import { t, type MessageKey } from "@/lib/i18n";

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
// The tab name is the state value as well as the label, so only the label
// moves into the catalogue.
const TAB_LABELS = {
  General: "settings.general",
  Account: "settings.account",
  Data: "settings.data",
  "Sheet View": "settings.sheetView",
  Users: "settings.users",
  Zones: "settings.zones",
} as const;
const THEME_LABELS = {
  system: "settings.themeSystem",
  light: "settings.themeLight",
  dark: "settings.themeDark",
} as const;

export default function SettingsView({ user }: { user: AppUser }) {
  const isAdmin = user.role === "admin";
  const tabs = isAdmin ? ADMIN_TABS : (user.role === "manager" ? MANAGER_TABS : TABS);
  const [tab, setTab] = useState<string>("General");

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto">
      <h1 className="text-large-title font-bold mb-5">{t("nav.settings")}</h1>
      {/* §Global: "Settings should also have sidebar tabs." A real left rail
          on desktop; the same list stays a horizontal strip on phones, where
          a side rail would eat most of the width. */}
      <div className="flex flex-col md:flex-row md:gap-8 items-start">
        <nav className="w-full md:w-48 shrink-0 flex md:flex-col gap-1.5 mb-6 md:mb-0 overflow-x-auto md:overflow-visible">
          {tabs.map((name) => (
            <button
              key={name}
              onClick={() => setTab(name)}
              className={`text-left whitespace-nowrap px-3.5 py-2 rounded-card text-caption md:text-subhead font-semibold border md:border-0 transition-colors ${
                tab === name
                  ? "bg-accent text-white border-accent md:bg-accent/12 md:text-accent"
                  : "border-hairline text-secondary hover:text-primary md:hover:bg-black/[0.03] md:dark:hover:bg-white/[0.05]"
              }`}
            >
              {t(TAB_LABELS[name])}
            </button>
          ))}
        </nav>

        <div className="flex-1 min-w-0 w-full">

      {tab === "General" && <GeneralTab isManager={(user.role === "manager" || user.role === "admin")} role={user.role} />}
      {tab === "Sheet View" && <SheetViewTab />}
      {tab === "Zones" && isAdmin && <ZonesTab />}
      {tab === "Data" && <DataTab isManager={(user.role === "manager" || user.role === "admin")} />}
      {tab === "Users" && <UsersTab currentUser={user} />}
      {tab === "Account" && <AccountTab user={user} />}
        </div>
      </div>
    </div>
  );
}

function GeneralTab({ isManager, role }: { isManager: boolean; role: AppUser["role"] }) {
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
        <Label>{t("settings.theme")}</Label>
        <div className="flex gap-2">
          {(["system", "light", "dark"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => apply(mode)}
              className={`px-4 py-2.5 rounded-card text-subhead font-medium border ${
                theme === mode ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
              }`}
            >
              {t(THEME_LABELS[mode])}
            </button>
          ))}
        </div>
      </div>

      <CurrencySection />

      <div>
        <Label>{t("settings.quickDownloadFormat")}</Label>
        <div className="flex gap-2 flex-wrap">
          {([
            { key: "pdf", label: t("settings.quickDownloadPdfOnly") },
            { key: "excel", label: t("settings.quickDownloadExcelOnly") },
            { key: "both", label: t("settings.quickDownloadBoth") },
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
          {t("settings.quickDownloadHint")}
        </p>
      </div>

      <div>
        <Label>{t("settings.colorfulData")}</Label>
        <label className="flex items-center gap-2 text-subhead">
          <input
            type="checkbox"
            checked={preferences.colorfulData === true}
            onChange={(e) => update({ colorfulData: e.target.checked })}
          />
          {t("settings.colorfulDataToggle")}
        </label>
        <p className="text-caption text-secondary mt-2">
          {t("settings.colorfulDataHint")}
        </p>
      </div>

      <NavShortcutsSection />

      {isManager && <AccentThemeSection />}
      {isManager && <BrandLogoSection />}

      <div>
        <Label>{t("settings.notifications")}</Label>
        <label className="flex items-center gap-2 text-subhead">
          <input
            type="checkbox"
            checked={preferences.notificationsEnabled !== false}
            onChange={(e) => update({ notificationsEnabled: e.target.checked })}
          />
          {t("settings.notificationsToggle")}
        </label>
        <p className="text-caption text-secondary mt-2">
          {t("settings.notificationsHint")}
        </p>
      </div>

      {isManager && <ReportStageSection />}
      {isManager && <DeliveryStepSection />}
      {role === "admin" && <ApprovalsSection />}
      <BottomBarSection role={role} />
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
      setError(e instanceof Error ? e.message : t("settings.failedToSave"));
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
      <Label>{t("settings.mapsKey")}</Label>
      <p className="text-caption text-secondary mb-2">
        {t("settings.mapsKeyHint")}
      </p>
      {configured ? (
        <div className="flex items-center gap-2">
          <Pill tone="accent">{t("settings.configured")}</Pill>
          <Button tier="plain" disabled={saving} onClick={remove} className="text-[--status-danger]">
            {saving ? t("settings.removing") : t("settings.removeKey")}
          </Button>
        </div>
      ) : (
        <div className="flex gap-2 items-center">
          <TextInput
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("settings.mapsKeyPlaceholder")}
            className="max-w-xs"
          />
          <Button tier="primary" disabled={saving || !apiKey.trim()} onClick={save}>
            {saving ? t("common.saving") : t("common.save")}
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
      <Label>{t("settings.overdueThreshold")}</Label>
      <div className="flex gap-2 items-center">
        <TextInput type="number" value={days} onChange={(e) => setDays(e.target.value)} className="max-w-[120px]" />
        <Button tier="primary" disabled={settingsId == null} onClick={save}>{saved ? t("settings.saved") : t("common.save")}</Button>
      </div>
      <p className="text-caption text-secondary mt-2">
        {t("settings.overdueThresholdHint")}
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
      toast.error(t("settings.reportStageUnavailable"));
    } else {
      invalidateReportStageCache();
    }
    setSaving(false);
  }

  if (unsupported) {
    return (
      <div>
        <Label>{t("settings.reportStage")}</Label>
        <p className="text-caption text-secondary">
          {t("settings.reportStageUnsupported")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <Label>{t("settings.reportStage")}</Label>
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
        {t("settings.reportStageHint")}
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
    { href: "/dashboard", label: t("nav.dashboard") },
    { href: "/orders", label: t("nav.orders") },
    { href: "/customers", label: t("nav.customers") },
    { href: "/products", label: t("nav.products") },
    { href: "/sales", label: t("nav.sales") },
    { href: "/payments", label: t("nav.payments") },
    { href: "/invoices", label: t("nav.invoices") },
    { href: "/reports", label: t("nav.reports") },
    { href: "/expense", label: t("nav.expense") },
    { href: "/settings", label: t("nav.settings") },
  ];

  return (
    <div>
      <Label>{t("settings.keyboardShortcuts")}</Label>
      <label className="flex items-center gap-2 text-subhead">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => update({ navShortcutsEnabled: e.target.checked })}
        />
        {t("settings.enableNavShortcuts")}
      </label>
      <p className="text-caption text-secondary mt-2">
        {t("settings.shortcutsPress")} <kbd className="px-1.5 py-0.5 rounded border border-hairline text-caption">g</kbd> {t("settings.shortcutsPressAfter")}
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
                aria-label={t("settings.shortcutKeyFor", { label: r.label })}
              />
            </div>
          ))}
        </div>
      )}

      {enabled && Object.keys(custom).length > 0 && (
        <div className="mt-2">
          <Button tier="plain" onClick={() => update({ navShortcutKeys: {} })}>
            {t("settings.resetToDefaults")}
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
      <Label>{t("settings.displayCurrency")}</Label>
      <select
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead"
        value={currency}
        onChange={(e) => setCurrency(e.target.value as CurrencyCode)}
      >
        {SUPPORTED_CURRENCIES.map((c) => (
          <option key={c.code} value={c.code}>{t("settings.currencyOption", { code: c.code, label: c.label })}</option>
        ))}
      </select>
      <p className="text-caption text-secondary mt-2">
        {t("settings.displayCurrencyHint")}
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
      toast.error(t("settings.accentSaveFailed"));
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
      <Label>{t("settings.appTheme")}</Label>
      <div className="flex gap-2 flex-wrap">
        {ACCENT_THEMES.map((opt) => (
          <button
            key={opt.key}
            onClick={() => choose(opt.key)}
            disabled={settingsId == null || unsupported}
            className={`flex items-center gap-2 px-3.5 py-2 rounded-card text-subhead font-medium border disabled:opacity-40 ${
              activeKey === opt.key ? "border-accent" : "border-hairline"
            }`}
          >
            <span
              className="w-4 h-4 rounded-full shrink-0"
              style={{ background: opt.accent }}
            />
            {saving === opt.key ? t("common.saving") : opt.label}
          </button>
        ))}
      </div>
      <p className="text-caption text-secondary mt-3">
        {unsupported
          ? t("settings.appThemeUnsupported")
          : t("settings.appThemeHint")}
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
      if (!res.ok) throw new Error(data.error ?? t("settings.uploadFailed"));
      refreshBrandLogo();
      setPreviewKey((k) => k + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    setUploading(true);
    setError(null);
    try {
      await fetch("/api/settings/brand-logo", { method: "DELETE" });
      refreshBrandLogo();
      setPreviewKey((k) => k + 1);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <Label>{t("settings.brandLogo")}</Label>
      <div className="flex items-center gap-4">
        <div className="w-20 h-20 rounded-card border border-hairline bg-surface grid place-items-center overflow-hidden shrink-0">
          {loaded && (
            // eslint-disable-next-line @next/next/no-img-element -- live preview of an uploaded asset
            <img key={previewKey} src={logoUrl} alt={t("settings.logoPreviewAlt")} className="max-w-full max-h-full object-contain" />
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
                  {uploading ? t("settings.uploading") : t("settings.uploadLogo")}
                </Button>
              </span>
            </label>
            <Button tier="plain" disabled={uploading} onClick={remove}>
              {t("settings.resetToDefault")}
            </Button>
          </div>
          <p className="text-caption text-secondary">{t("settings.brandLogoHint")}</p>
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
      toast.error(friendlyError(e, t("settings.failedToAddZone")));
    } finally {
      setSavingZone(false);
    }
  }

  async function makeDefault(id: string) {
    await setDefaultZone(supabaseBrowser(), id);
    load();
  }

  async function removeZone(id: string) {
    if (!confirm(t("settings.confirmRemoveZone"))) return;
    try {
      await deleteZone(supabaseBrowser(), id);
      load();
    } catch (e) {
      toast.error(friendlyError(e, t("settings.failedToRemoveZone")));
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
      toast.error(friendlyError(e, t("settings.failedToAddCountry")));
    } finally {
      setSavingCountry(false);
    }
  }

  async function removeCountry(code: string) {
    await removeZoneCountry(supabaseBrowser(), code);
    load();
  }

  if (loading) return <p className="text-caption text-secondary">{t("common.loading")}</p>;

  if (unsupported) {
    return (
      <p className="text-caption text-secondary">
        {t("settings.zonesUnsupported")}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <Label>{t("settings.zones")}</Label>
        <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline mb-3">
          {zones.map((z) => (
            <div key={z.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <div className="text-subhead font-medium flex items-center gap-2">
                  {z.name}
                  {z.is_default && <Pill tone="accent">{t("settings.defaultZone")}</Pill>}
                </div>
                <div className="text-caption text-secondary">
                  {t("settings.zoneVatLine", { vat: Math.round(z.vat_rate * 100), currency: z.currency_code })}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!z.is_default && (
                  <Button tier="plain" onClick={() => makeDefault(z.id)}>{t("settings.makeDefault")}</Button>
                )}
                <Button tier="plain" className="text-[--status-danger]" onClick={() => removeZone(z.id)}>
                  {t("common.remove")}
                </Button>
              </div>
            </div>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap items-end">
          <div className="flex-1 min-w-[140px]">
            <Label>{t("settings.zoneName")}</Label>
            <TextInput value={newZoneName} onChange={(e) => setNewZoneName(e.target.value)} placeholder={t("settings.zoneNamePlaceholder")} />
          </div>
          <div className="w-24">
            <Label>{t("settings.vatPercent")}</Label>
            <TextInput type="number" value={newZoneVat} onChange={(e) => setNewZoneVat(e.target.value)} />
          </div>
          <div className="w-24">
            <Label>{t("settings.currency")}</Label>
            <TextInput value={newZoneCurrency} onChange={(e) => setNewZoneCurrency(e.target.value.toUpperCase())} maxLength={3} />
          </div>
          <Button tier="primary" disabled={savingZone || !newZoneName.trim()} onClick={addZone}>
            {savingZone ? t("settings.adding") : t("settings.addZone")}
          </Button>
        </div>
      </div>

      <div>
        <Label>{t("settings.countries")}</Label>
        <p className="text-caption text-secondary mb-2">
          {t("settings.countriesHint")}
        </p>
        {countries.length > 0 && (
          <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline mb-3">
            {countries.map((c) => {
              const zone = zones.find((z) => z.id === c.zone_id);
              return (
                <div key={c.country_code} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-subhead font-medium">{t("settings.countryNameCode", { name: c.country_name, code: c.country_code })}</div>
                    <div className="text-caption text-secondary">
                      {t("settings.countryZoneLine", {
                        zone: zone?.name ?? t("common.notSet"),
                        currency:
                          c.currency_code ??
                          t("settings.zoneDefaultCurrency", { currency: zone?.currency_code ?? "AED" }),
                      })}
                    </div>
                  </div>
                  <Button tier="plain" className="text-[--status-danger]" onClick={() => removeCountry(c.country_code)}>
                    {t("common.remove")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex gap-2 flex-wrap items-end">
          <div className="w-20">
            <Label>{t("settings.countryCode")}</Label>
            <TextInput value={countryCode} onChange={(e) => setCountryCode(e.target.value.toUpperCase())} placeholder={t("settings.countryCodePlaceholder")} maxLength={2} />
          </div>
          <div className="flex-1 min-w-[120px]">
            <Label>{t("settings.countryName")}</Label>
            <TextInput value={countryName} onChange={(e) => setCountryName(e.target.value)} placeholder={t("settings.countryNamePlaceholder")} />
          </div>
          <div className="min-w-[140px]">
            <Label>{t("settings.zone")}</Label>
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
            <Label>{t("settings.currencyOverride")}</Label>
            <TextInput value={countryCurrency} onChange={(e) => setCountryCurrency(e.target.value.toUpperCase())} placeholder={t("settings.currencyOverridePlaceholder")} maxLength={3} />
          </div>
          <Button tier="primary" disabled={savingCountry || !countryCode.trim() || !countryName.trim()} onClick={addCountry}>
            {savingCountry ? t("settings.adding") : t("settings.addCountry")}
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
      <Label>{t("settings.downloadOrder")}</Label>
      <div className="flex gap-2">
        <button
          onClick={() => update({ downloadSeparateMarked: false })}
          className={`px-4 py-2.5 rounded-card text-subhead font-medium border ${
            !separateMarked ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
          }`}
        >
          {t("settings.articleOrder")}
        </button>
        <button
          onClick={() => update({ downloadSeparateMarked: true })}
          className={`px-4 py-2.5 rounded-card text-subhead font-medium border ${
            separateMarked ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
          }`}
        >
          {t("settings.separateMarkedUnmarked")}
        </button>
      </div>
      <p className="text-caption text-secondary mt-3">
        {t("settings.downloadOrderHint")}
      </p>
    </div>
  );
}

// All roles (§6): bulk "Download All" for each data type — Excel for
// Manager, PDF for everyone else, the same export-format rule already
// applied everywhere else in the app, just generalized beyond Invoices.
function DataTab({ isManager }: { isManager: boolean }) {
  const types: { key: string; label: string }[] = [
    { key: "customers", label: t("nav.customers") },
    { key: "products", label: t("nav.products") },
    { key: "orders", label: t("nav.orders") },
  ];
  const endpoint = isManager ? "/api/export/excel" : "/api/export/pdf";
  return (
    <div className="space-y-3">
      {types.map((item) => (
        <a
          key={item.key}
          href={`${endpoint}?type=${item.key}`}
          target={isManager ? undefined : "_blank"}
          rel="noreferrer"
          className="flex items-center justify-between px-4 py-3.5 rounded-card border border-hairline hover:border-accent/50 transition"
        >
          <span className="text-subhead font-medium">{t("settings.downloadAllType", { type: item.label })}</span>
          <span className="flex items-center gap-1.5 text-caption font-semibold text-accent">
            <Download size={14} /> {isManager ? t("settings.excel") : t("settings.pdf")}
          </span>
        </a>
      ))}
      {/* One file with everything in it, for keeping. The phone has had this
          since V5 (SettingsView.swift, BackupExportRow) — customers,
          products, orders, payments and expenses in a single JSON, read with
          the caller's own session so it can never hold more than they could
          already see. */}
      {isManager && (
        <a
          href="/api/export/backup"
          className="flex items-center justify-between px-4 py-3.5 rounded-card border border-hairline hover:border-accent/50 transition"
        >
          <span className="min-w-0">
            <span className="block text-subhead font-medium">{t("settings.downloadDataBackup")}</span>
            <span className="block text-caption text-secondary">
              {t("settings.dataBackupHint")}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-caption font-semibold text-accent shrink-0">
            <Download size={14} /> {t("settings.json")}
          </span>
        </a>
      )}
      {isManager && <DataGrid />}
      {isManager && <DuplicateOrdersSection />}
    </div>
  );
}

// Orders that were sent twice. See app/api/orders/duplicates for the rule.
function DuplicateOrdersSection() {
  interface Dup {
    id: string;
    invoiceNumber: string | null;
    createdAt: string;
    customerName: string;
    salesman: string;
    itemCount: number;
    total: number;
  }
  const [groups, setGroups] = useState<Dup[][] | null>(null);
  const [keep, setKeep] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);

  async function scan() {
    setBusy(true);
    try {
      const res = await fetch("/api/orders/duplicates");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("settings.couldntCheckDuplicates"));
      const found: Dup[][] = data.groups ?? [];
      setGroups(found);
      // The oldest copy in each group is the one to keep by default.
      setKeep(Object.fromEntries(found.map((g, i) => [i, g[0].id])));
      setScanned(true);
    } catch (e) {
      toast.error(friendlyError(e, t("settings.couldntCheckDuplicates")));
    } finally {
      setBusy(false);
    }
  }

  const toRemove = (groups ?? []).flatMap((g, i) => g.filter((o) => o.id !== keep[i]).map((o) => o.id));

  async function remove() {
    if (toRemove.length === 0) return;
    if (
      !confirm(
        t(
          toRemove.length === 1
            ? "settings.confirmRemoveDuplicateOne"
            : "settings.confirmRemoveDuplicateMany",
          { n: toRemove.length }
        )
      )
    )
      return;
    setBusy(true);
    try {
      const res = await fetch("/api/orders/duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: toRemove }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("settings.couldntRemoveDuplicates"));
      toast.success(
        t(data.deleted === 1 ? "settings.removedDuplicateOne" : "settings.removedDuplicateMany", {
          n: data.deleted,
        })
      );
      await scan();
    } catch (e) {
      toast.error(friendlyError(e, t("settings.couldntRemoveDuplicates")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 pt-5 border-t border-hairline">
      <h3 className="text-subhead font-semibold mb-1">{t("settings.ordersSentTwice")}</h3>
      <p className="text-caption text-secondary mb-3 max-w-[60ch]">
        {t("settings.duplicatesHint")}
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        <Button tier="tinted" disabled={busy} onClick={scan}>
          {busy && !scanned ? t("settings.checking") : t("settings.checkForDuplicates")}
        </Button>
        {toRemove.length > 0 && (
          <Button tier="danger" disabled={busy} onClick={remove}>
            {t(toRemove.length === 1 ? "settings.removeDuplicateOne" : "settings.removeDuplicateMany", { n: toRemove.length })}
          </Button>
        )}
      </div>

      {scanned && groups?.length === 0 && (
        <p className="text-subhead text-secondary mt-3">{t("settings.noDuplicates")}</p>
      )}

      {groups?.map((group, gi) => (
        <div key={gi} className="mt-3 border border-hairline rounded-card overflow-hidden">
          <div className="px-3.5 py-2 bg-canvas text-caption text-secondary">
            {t(
              group[0].itemCount === 1 ? "settings.duplicateGroupOne" : "settings.duplicateGroupMany",
              { customer: group[0].customerName, lines: group[0].itemCount, copies: group.length }
            )}
          </div>
          {group.map((o) => (
            <label
              key={o.id}
              className="flex items-center gap-3 px-3.5 py-2.5 border-t border-hairline cursor-pointer text-subhead"
            >
              <input
                type="radio"
                name={`dup-${gi}`}
                checked={keep[gi] === o.id}
                onChange={() => setKeep((prev) => ({ ...prev, [gi]: o.id }))}
              />
              <span className="flex-1 min-w-0">
                <span className="font-medium">
                  {o.invoiceNumber ? t("settings.invoiceNumberHash", { number: o.invoiceNumber }) : t("settings.noInvoiceNumberYet")}
                </span>
                <span className="text-caption text-secondary">
                  {" "}
                  {t("settings.duplicateOrderMeta", {
                    when: new Date(o.createdAt).toLocaleString(),
                    salesman: o.salesman,
                  })}
                </span>
              </span>
              <span className="tabular-nums text-secondary shrink-0">{formatAed(o.total)}</span>
              <span
                className={`text-caption font-semibold shrink-0 ${
                  keep[gi] === o.id ? "text-accent" : "text-[--status-danger]"
                }`}
              >
                {keep[gi] === o.id ? t("settings.keep") : t("common.remove")}
              </span>
            </label>
          ))}
        </div>
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
      toast.error(t("sales.goalInvalid"));
      return;
    }
    // Ask for the changed row back. A write the database declines to apply is
    // not an error — it reports success and simply changes nothing — so
    // without this the screen said "Goal saved." while the goal stayed as it
    // was. An empty result is the only way to tell the difference.
    const { data: saved, error } = await supabaseBrowser()
      .from("users")
      .update({ monthly_target: target })
      .eq("id", userId)
      .select("id");
    if (error) {
      toast.error(friendlyError(error, t("sales.goalSaveFailed")));
      return;
    }
    if (!saved || saved.length === 0) {
      toast.error(t("sales.goalNoPermission"));
      return;
    }
    toast.success(target === null ? t("sales.goalCleared") : t("sales.goalSaved"));
    load();
  }

  // The bonus and the special offer the phone has kept per salesman since V5
  // (GoalsStore.swift), now stored on the same row as the goal. Both save the
  // way the goal does — refusals are reported, not swallowed.
  async function saveBonus(userId: string, value: string) {
    const trimmed = value.trim();
    const bonus = trimmed === "" ? null : Number(trimmed);
    if (bonus !== null && (!Number.isFinite(bonus) || bonus < 0)) {
      toast.error(t("sales.bonusInvalid"));
      return;
    }
    try {
      const applied = await saveIncentive(supabaseBrowser(), userId, { monthly_bonus: bonus });
      if (!applied) {
        toast.error(t("sales.bonusNoPermission"));
        return;
      }
      toast.success(bonus === null ? t("sales.bonusCleared") : t("sales.bonusSaved"));
      load();
    } catch (e) {
      toast.error(friendlyError(e, t("sales.bonusSaveFailed")));
    }
  }

  async function saveNote(userId: string, value: string) {
    const note = value.trim();
    try {
      const applied = await saveIncentive(supabaseBrowser(), userId, {
        incentive_note: note === "" ? null : note,
      });
      if (!applied) {
        toast.error(t("sales.incentiveNoPermission"));
        return;
      }
      toast.success(note === "" ? t("sales.offerCleared") : t("sales.offerSaved"));
      load();
    } catch (e) {
      toast.error(friendlyError(e, t("sales.offerSaveFailed")));
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <div className="flex justify-end mb-3">
        <Button tier="primary" onClick={() => setShowNew(true)}>{t("settings.addUser")}</Button>
      </div>
      <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
        {users.map((u) => (
          <div key={u.id} className="hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
          <div className="w-full flex items-center justify-between gap-3 px-4 py-3">
            <button onClick={() => setEditing(u)} className="flex-1 min-w-0 text-left">
              <div className="text-subhead font-medium truncate">{u.full_name}</div>
              <div className="text-caption text-secondary truncate">{t("settings.userHandleRole", { username: u.username, role: u.role })}</div>
            </button>
            {targetsSupported && u.role === "salesman" && (
              <label className="flex items-center gap-2 shrink-0">
                <span className="text-caption text-secondary hidden sm:inline">{t("settings.monthlyGoal")}</span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  defaultValue={targets?.byUser.get(u.id) ?? ""}
                  placeholder={String(targets?.fallback ?? "")}
                  onBlur={(e) => saveTarget(u.id, e.target.value)}
                  className="w-28 px-3 py-1.5 rounded-chip border border-hairline bg-canvas text-subhead tabular-nums text-right"
                  title={t("sales.goalHint")}
                />
              </label>
            )}
            {/* The bonus sits beside the goal it is earned against, in the
                same AED figures. Blank is not zero: blank is "no bonus set",
                which is what the phone means by an absent entry. */}
            {targets?.bonusSupported && u.role === "salesman" && (
              <label className="flex items-center gap-2 shrink-0">
                <span className="text-caption text-secondary hidden sm:inline">{t("settings.bonus")}</span>
                <input
                  type="number"
                  min="0"
                  step="100"
                  defaultValue={targets.bonusByUser.get(u.id) ?? ""}
                  placeholder={t("common.none")}
                  onBlur={(e) => saveBonus(u.id, e.target.value)}
                  className="w-24 px-3 py-1.5 rounded-chip border border-hairline bg-canvas text-subhead tabular-nums text-right"
                  title={t("sales.bonusHint")}
                />
              </label>
            )}
            <Pill tone={u.is_active ? "accent" : "danger"}>{u.is_active ? t("settings.active") : t("settings.deactivated")}</Pill>
          </div>
          {/* The special offer gets its own line — it is a sentence, not a
              figure, and it would squeeze the row it shared. */}
          {targets?.bonusSupported && u.role === "salesman" && (
            <label className="flex items-center gap-2 px-4 pb-3 -mt-1">
              <span className="text-caption text-secondary shrink-0">{t("settings.specialOffer")}</span>
              <input
                type="text"
                defaultValue={targets.noteByUser.get(u.id) ?? ""}
                placeholder={t("sales.offerPlaceholder")}
                onBlur={(e) => saveNote(u.id, e.target.value)}
                className="flex-1 min-w-0 px-3 py-1.5 rounded-chip border border-hairline bg-canvas text-caption"
                title={t("sales.offerHint")}
              />
            </label>
          )}
          </div>
        ))}
      </div>

      {targetsSupported ? (
        <p className="text-caption text-secondary mt-2">
          {t("settings.goalsHint", { amount: formatAed(targets?.fallback ?? 0) })}
        </p>
      ) : (
        <p className="text-caption text-secondary mt-2">
          {t("settings.goalsUnsupported")}
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
      setError(e instanceof Error ? e.message : t("settings.failed"));
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
      setError(e instanceof Error ? e.message : t("settings.failedToRemoveUser"));
      setRemoving(false);
      setConfirmRemove(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={user ? t("settings.editUser") : t("settings.addUser")}
      footer={
        <>
          {user && !isSelf && !readOnly && (
            confirmRemove ? (
              <>
                <Button tier="plain" onClick={() => setConfirmRemove(false)}>{t("settings.neverMind")}</Button>
                <Button tier="danger" disabled={removing} onClick={remove}>
                  {removing ? t("settings.removing") : t("settings.confirmRemove")}
                </Button>
              </>
            ) : (
              <Button tier="plain" onClick={() => setConfirmRemove(true)} className="text-[--status-danger] me-auto">
                {t("settings.removeUser")}
              </Button>
            )
          )}
          {!confirmRemove && (
            <>
              <Button tier="plain" onClick={onClose}>{readOnly ? t("common.close") : t("common.cancel")}</Button>
              {!readOnly && (
                <Button tier="primary" disabled={saving} onClick={save}>{saving ? t("common.saving") : t("common.save")}</Button>
              )}
            </>
          )}
        </>
      }
    >
      {!user && (
        <>
          <Label>{t("settings.username")}</Label>
          <TextInput value={username} onChange={(e) => setUsername(e.target.value)} disabled={readOnly} autoCapitalize="none" />
        </>
      )}
      <Label>{t("settings.fullName")}</Label>
      <TextInput value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} />
      <Label>{t("settings.role")}</Label>
      <select
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead disabled:opacity-50"
        value={role}
        disabled={isSelf || readOnly}
        onChange={(e) => setRole(e.target.value as AppUser["role"])}
      >
        <option value="salesman">{t("nav.role.salesman")}</option>
        <option value="manager">{t("nav.role.manager")}</option>
        <option value="warehouse">{t("nav.role.warehouse")}</option>
        {(isCallerAdmin || targetIsAdmin) && <option value="admin">{t("nav.role.admin")}</option>}
      </select>
      <Label>{user ? t("settings.resetPassword") : t("settings.password")}</Label>
      <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={readOnly} />
      {user && !isSelf && (
        <label className="flex items-center gap-2 mt-4 text-subhead">
          <input type="checkbox" checked={active} disabled={readOnly} onChange={(e) => setActive(e.target.checked)} />
          {t("settings.active")}
        </label>
      )}
      {isSelf && (
        <p className="text-caption text-secondary mt-4">
          {t("settings.selfEditNotice")}
        </p>
      )}
      {readOnly && (
        <p className="text-caption text-secondary mt-4">
          {t("settings.adminOnlyEditNotice")}
        </p>
      )}
      {error && <div className="mt-3 text-caption text-[--status-danger]">{error}</div>}
    </Sheet>
  );
}

// Your own photo, shown wherever you already appear — the account button in
// the header, and here. Replaces, never accumulates: one object per person,
// at the same key the phone writes (AccountSheet.swift), so a photo set on
// either app is the photo on both.
function AvatarSection({ user }: { user: AppUser }) {
  const { url: avatarUrl, loaded } = useAvatar(user.id);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/account/avatar", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("settings.uploadFailed"));
      // Tells the header too, not just this preview.
      refreshAvatar(user.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settings.uploadFailed"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <Label>{t("settings.photo")}</Label>
      <div className="flex items-center gap-4">
        <div className="w-20 h-20 rounded-full bg-accent text-white font-bold grid place-items-center text-title shrink-0 overflow-hidden">
          {loaded && avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- live preview of an uploaded asset
            <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            initialsOf(user.full_name, user.username)
          )}
        </div>
        <div className="flex flex-col gap-2">
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
                {uploading ? t("settings.uploading") : avatarUrl ? t("settings.replacePhoto") : t("settings.uploadPhoto")}
              </Button>
            </span>
          </label>
          <p className="text-caption text-secondary">
            {t("settings.photoHint")}
          </p>
          {error && <p className="text-caption text-[--status-danger]">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function AccountTab({ user }: { user: AppUser }) {
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
      if (!res.ok) throw new Error(data.error ?? t("settings.failedToSave"));
      setContactSaved(true);
      setTimeout(() => setContactSaved(false), 2000);
    } catch (e) {
      setContactError(e instanceof Error ? e.message : t("settings.failedToSave"));
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
      setPasswordError(e instanceof Error ? e.message : t("settings.failedToChangePassword"));
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
      setMessage(e instanceof Error ? e.message : t("settings.failedToLinkGoogle"));
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="space-y-6">
      <AvatarSection user={user} />

      <div>
        <Label>{t("settings.email")}</Label>
        <TextInput
          type="email"
          value={email}
          disabled={!contactLoaded}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("settings.emailPlaceholder")}
        />
        <Label>{t("settings.phone")}</Label>
        <TextInput
          type="tel"
          value={phone}
          disabled={!contactLoaded}
          onChange={(e) => setPhone(e.target.value)}
          placeholder={t("settings.phonePlaceholder")}
        />
        <div className="flex items-center gap-2 mt-2">
          <Button tier="primary" disabled={savingContact || !contactLoaded} onClick={saveContact}>
            {savingContact ? t("common.saving") : contactSaved ? t("settings.saved") : t("settings.saveContactInfo")}
          </Button>
        </div>
        {contactError && <div className="mt-2 text-caption text-[--status-danger]">{contactError}</div>}
        <p className="text-caption text-secondary mt-2">
          {t("settings.emailHint")}
        </p>
      </div>

      <div>
        <Label>{t("settings.changePassword")}</Label>
        <TextInput
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder={t("settings.newPasswordPlaceholder")}
        />
        <div className="flex items-center gap-2 mt-2">
          <Button tier="primary" disabled={savingPassword || !newPassword} onClick={changePassword}>
            {savingPassword ? t("common.saving") : passwordSaved ? t("settings.saved") : t("settings.changePassword")}
          </Button>
        </div>
        {passwordError && <div className="mt-2 text-caption text-[--status-danger]">{passwordError}</div>}
      </div>

      <div>
        <Label>{t("settings.signInOptions")}</Label>
        <Button tier="tinted" disabled={linking} onClick={linkGoogle}>
          {linking ? t("settings.openingGoogle") : t("settings.linkGoogle")}
        </Button>
        {message && <div className="mt-2 text-caption text-[--status-danger]">{message}</div>}
      </div>

      <div>
        <Label>{t("settings.session")}</Label>
        <Button tier="danger" onClick={logout}>{t("settings.logOut")}</Button>
      </div>
    </div>
  );
}

// Whether the business uses a delivery step at all.
//
// Some operations hand goods over when the invoice is raised and never track a
// separate delivery; for them the warehouse's Delivery tab is dead weight and
// its proof photos are ceremony. One answer, set by the manager, followed
// everywhere.
function DeliveryStepSection() {
  const [enabled, setEnabled] = useState(DELIVERY_STEP_DEFAULT);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = supabaseBrowser();
    supabase
      .from("app_settings")
      .select("delivery_enabled")
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) { setUnsupported(true); return; }
        setEnabled((data?.delivery_enabled as boolean | null) ?? DELIVERY_STEP_DEFAULT);
      });
  }, []);

  async function save(next: boolean) {
    setSaving(true);
    const prev = enabled;
    setEnabled(next); // Optimistic, rolled back below if it does not take.
    const result = await setDeliveryEnabled(supabaseBrowser(), next);
    if (!result.ok) {
      setEnabled(prev);
      toast.error(result.error ?? t("settings.couldntSaveThat"));
    } else {
      toast.success(next ? t("settings.deliveryStepOn") : t("settings.deliveryStepOff"));
    }
    setSaving(false);
  }

  if (unsupported) {
    return (
      <div>
        <Label>{t("nav.delivery")}</Label>
        <p className="text-caption text-secondary">
          {t("settings.deliveryUnsupported")}
        </p>
      </div>
    );
  }

  return (
    <div>
      <Label>{t("nav.delivery")}</Label>
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => save(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="block text-subhead font-semibold">{t("settings.trackDeliveries")}</span>
          <span className="block text-caption text-secondary mt-1">
            {t("settings.trackDeliveriesHint")}
          </span>
        </span>
      </label>
    </div>
  );
}

// Which actions wait for a manager. Admin only, here and in the database: a
// trigger refuses anyone else who tries to change one of these.
//
// Unticking one hands a salesman or the warehouse something only a manager
// could do until now, so each line says plainly what that is.
const APPROVAL_ROWS: { key: ApprovalKey; title: MessageKey; hint: MessageKey }[] = [
  { key: "customerChanges", title: "settings.approvalCustomerChanges", hint: "settings.approvalCustomerChangesHint" },
  { key: "orderEdits", title: "settings.approvalOrderEdits", hint: "settings.approvalOrderEditsHint" },
  { key: "goodsReturns", title: "settings.approvalGoodsReturns", hint: "settings.approvalGoodsReturnsHint" },
];

function ApprovalsSection() {
  const [settings, setSettings] = useState<ApprovalSettings>(APPROVALS_DEFAULT);
  const [unsupported, setUnsupported] = useState(false);
  const [savingKey, setSavingKey] = useState<ApprovalKey | null>(null);

  useEffect(() => {
    fetchApprovalSettings(supabaseBrowser()).then((next) => {
      setSettings(next);
      setUnsupported(!approvalSettingsSupported());
    });
  }, []);

  async function save(key: ApprovalKey, needed: boolean) {
    setSavingKey(key);
    const prev = settings;
    setSettings({ ...prev, [key]: needed }); // Optimistic, rolled back below if it does not take.
    const result = await setApprovalNeeded(supabaseBrowser(), key, needed);
    if (!result.ok) {
      setSettings(prev);
      toast.error(result.error ?? t("settings.couldntSaveThat"));
    } else {
      toast.success(needed ? t("settings.approvalNowNeeded") : t("settings.approvalNoLongerNeeded"));
    }
    setSavingKey(null);
  }

  if (unsupported) {
    return (
      <div>
        <Label>{t("settings.approvals")}</Label>
        <p className="text-caption text-secondary">{t("settings.approvalsUnsupported")}</p>
      </div>
    );
  }

  return (
    <div>
      <Label>{t("settings.approvals")}</Label>
      <p className="text-caption text-secondary mb-3">{t("settings.approvalsIntro")}</p>
      <div className="flex flex-col gap-3">
        {APPROVAL_ROWS.map((row) => (
          <label key={row.key} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings[row.key]}
              disabled={savingKey !== null}
              onChange={(e) => save(row.key, e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="block text-subhead font-semibold">{t(row.title)}</span>
              <span className="block text-caption text-secondary mt-1">{t(row.hint)}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

// Which destinations sit in the bottom bar on a phone, and which go behind
// More. Everyone works differently — a salesman lives in Orders and Customers,
// the warehouse in Picking — so the four that matter should be each person's
// own choice rather than a fixed guess.
//
// Only affects the phone bar. The desktop sidebar has room for everything and
// shows the lot.
function BottomBarSection({ role }: { role: AppUser["role"] }) {
  const { preferences, update } = usePreferences();
  const available = navFor(role);
  const current = primaryNavFor(role, preferences.primaryNav);
  const currentHrefs = current.map((i) => i.href);

  function toggle(href: string) {
    const isOn = currentHrefs.includes(href);
    if (isOn) {
      // Never leave the bar empty; one destination has to remain.
      if (currentHrefs.length <= 1) {
        toast.error(t("settings.keepOneTab"));
        return;
      }
      update({ primaryNav: currentHrefs.filter((h) => h !== href) });
      return;
    }
    if (currentHrefs.length >= MAX_PRIMARY_NAV) {
      toast.error(t("settings.barIsFull", { n: MAX_PRIMARY_NAV }));
      return;
    }
    update({ primaryNav: [...currentHrefs, href] });
  }

  return (
    <div>
      <Label>{t("settings.tabsOnYourPhone")}</Label>
      <p className="text-caption text-secondary mb-3">
        {t("settings.tabsOnYourPhoneHint", { n: MAX_PRIMARY_NAV })}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {available.map((item) => {
          const on = currentHrefs.includes(item.href);
          return (
            <label
              key={item.href}
              className={`flex items-center gap-2.5 px-3 py-2.5 rounded-card border cursor-pointer transition-colors ${
                on ? "border-accent/40 bg-accent/[0.04]" : "border-hairline"
              }`}
            >
              <input type="checkbox" checked={on} onChange={() => toggle(item.href)} />
              <span className="text-subhead truncate">{item.label}</span>
            </label>
          );
        })}
      </div>
      {preferences.primaryNav && preferences.primaryNav.length > 0 && (
        <button
          onClick={() => update({ primaryNav: [] })}
          className="mt-3 text-caption text-secondary hover:text-accent"
        >
          {t("settings.resetToRoleDefault")}
        </button>
      )}
    </div>
  );
}
