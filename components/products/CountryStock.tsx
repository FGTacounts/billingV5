"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/toast";
import Button from "@/components/ui/Button";
import { Label, TextInput } from "@/components/ui/Field";
import { Skeleton } from "@/components/ui/Empty";
import {
  fetchCountryStock,
  moveStock,
  removeCountryStock,
  setCountryStock,
  type CountryStock as CountryStockData,
  type CountryStockRow,
} from "@/lib/queries/countryStock";

// Stock in other countries, under each SKU (owner, 2026-11-13: "only some
// products will have stock overseas … put that option under each SKU").
// "Stock on hand" in the editor stays the UAE. Every change here is written
// the moment it is made, like shared stock, and shown before the database
// answers; a refusal puts the figures back as they were.

const SELECT =
  "w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition";

const UAE = "uae";
const NEW = "new";

function place(r: { country: string; name: string }) {
  return t("countryStock.place", { country: r.country, name: r.name });
}

function wholeNumber(s: string): number | null {
  if (!/^\d+$/.test(s.trim())) return null;
  return Number(s.trim());
}

export default function CountryStock({
  productId,
  onUaeChanged,
  onChanged,
}: {
  productId: string;
  /** The UAE figure after a move, so the editor's Save does not write the old one back. */
  onUaeChanged: (uae: number | null) => void;
  /** Something was written: the list behind the sheet should be read again. */
  onChanged: () => void;
}) {
  const [data, setData] = useState<CountryStockData | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirmRemove, setConfirmRemove] = useState<CountryStockRow | null>(null);

  const [adding, setAdding] = useState(false);
  const [addWarehouse, setAddWarehouse] = useState<string>(NEW);
  const [addCountry, setAddCountry] = useState("");
  const [addName, setAddName] = useState("");
  const [addQty, setAddQty] = useState("");

  const [moving, setMoving] = useState(false);
  const [moveFrom, setMoveFrom] = useState<string>(UAE);
  const [moveTo, setMoveTo] = useState<string>("");
  const [moveQty, setMoveQty] = useState("");

  const load = useCallback(() => {
    fetchCountryStock(productId)
      .then((d) => {
        setData(d);
        setDrafts({});
      })
      .catch(() => setData({ ready: false, rows: [], warehouses: [], uae: null }));
  }, [productId]);

  useEffect(load, [load]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const unused = useMemo(
    () => (data?.warehouses ?? []).filter((w) => !rows.some((r) => r.warehouse_id === w.id)),
    [data, rows]
  );

  // The figure each place holds right now, for the move form.
  function have(key: string): number {
    if (key === UAE) return Math.max(0, data?.uae ?? 0);
    return rows.find((r) => r.warehouse_id === key)?.qty ?? 0;
  }
  function label(key: string): string {
    if (key === UAE) return t("countryStock.uae");
    const w = data?.warehouses.find((x) => x.id === key) ?? rows.find((r) => r.warehouse_id === key);
    return w ? place(w) : "";
  }

  // Runs one write: shows `optimistic` at once, then the database's answer,
  // or puts back what was there.
  async function write(optimistic: CountryStockData, run: () => Promise<CountryStockData>, done?: string) {
    if (!data) return false;
    const before = data;
    setData(optimistic);
    setBusy(true);
    try {
      const fresh = await run();
      setData(fresh);
      setDrafts({});
      if (fresh.uae !== before.uae) onUaeChanged(fresh.uae);
      onChanged();
      if (done) toast.success(done);
      return true;
    } catch (e) {
      setData(before);
      toast.error(e instanceof Error ? e.message : t("countryStock.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveRowQty(row: CountryStockRow) {
    const raw = drafts[row.warehouse_id];
    if (raw === undefined) return;
    const qty = wholeNumber(raw);
    if (qty == null) {
      toast.error(t("countryStock.qtyInvalid"));
      return;
    }
    if (qty === row.qty || !data) {
      setDrafts((d) => {
        const { [row.warehouse_id]: _, ...rest } = d;
        return rest;
      });
      return;
    }
    await write(
      { ...data, rows: rows.map((r) => (r.warehouse_id === row.warehouse_id ? { ...r, qty } : r)) },
      () => setCountryStock(productId, { warehouseId: row.warehouse_id }, qty)
    );
  }

  async function remove(row: CountryStockRow) {
    setConfirmRemove(null);
    if (!data) return;
    await write({ ...data, rows: rows.filter((r) => r.warehouse_id !== row.warehouse_id) }, () =>
      removeCountryStock(productId, row.warehouse_id)
    );
  }

  function openAdd() {
    setMoving(false);
    setAdding(true);
    setAddWarehouse(unused[0]?.id ?? NEW);
    setAddCountry("");
    setAddName("");
    setAddQty("");
  }

  async function saveAdd() {
    if (!data) return;
    const qty = wholeNumber(addQty);
    if (qty == null) {
      toast.error(t("countryStock.qtyInvalid"));
      return;
    }
    const isNew = addWarehouse === NEW;
    const country = addCountry.trim();
    const name = addName.trim();
    if (isNew && (!country || !name)) {
      toast.error(t("countryStock.warehouseNameInvalid"));
      return;
    }
    const known = data.warehouses.find((w) => w.id === addWarehouse);
    const shown: CountryStockRow = isNew
      ? { warehouse_id: `pending-${country}-${name}`, country, name, qty }
      : { warehouse_id: addWarehouse, country: known?.country ?? "", name: known?.name ?? "", qty };
    const ok = await write({ ...data, rows: [...rows, shown] }, () =>
      setCountryStock(productId, isNew ? { country, name } : { warehouseId: addWarehouse }, qty)
    );
    if (ok) setAdding(false);
  }

  function openMove() {
    setAdding(false);
    setMoving(true);
    // The usual case: goods arriving from abroad into the UAE.
    const from = rows[0]?.warehouse_id ?? UAE;
    setMoveFrom(from);
    setMoveTo(from === UAE ? (data?.warehouses[0]?.id ?? "") : UAE);
    setMoveQty("");
  }

  async function saveMove() {
    if (!data) return;
    const qty = wholeNumber(moveQty);
    if (qty == null || qty <= 0) {
      toast.error(t("countryStock.qtyInvalid"));
      return;
    }
    if (moveFrom === moveTo) {
      toast.error(t("countryStock.moveSamePlace"));
      return;
    }
    if (qty > have(moveFrom)) {
      toast.error(t("countryStock.moveShort", { have: have(moveFrom) }));
      return;
    }
    const step = (key: string, delta: number, d: CountryStockData): CountryStockData => {
      if (key === UAE) return { ...d, uae: Math.max(0, d.uae ?? 0) + delta };
      const exists = d.rows.some((r) => r.warehouse_id === key);
      const w = d.warehouses.find((x) => x.id === key);
      return {
        ...d,
        rows: exists
          ? d.rows.map((r) => (r.warehouse_id === key ? { ...r, qty: r.qty + delta } : r))
          : [...d.rows, { warehouse_id: key, country: w?.country ?? "", name: w?.name ?? "", qty: delta }],
      };
    };
    const optimistic = step(moveTo, qty, step(moveFrom, -qty, data));
    const ok = await write(
      optimistic,
      () => moveStock(productId, moveFrom === UAE ? null : moveFrom, moveTo === UAE ? null : moveTo, qty),
      t("countryStock.moved", { qty, from: label(moveFrom), to: label(moveTo) })
    );
    if (ok) setMoving(false);
  }

  if (data === null) {
    return (
      <div>
        <Label>{t("countryStock.title")}</Label>
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }
  if (!data.ready) return null;

  // Every place stock can go: the UAE and every warehouse, whether or not
  // this SKU has a row there yet.
  const destinations = [UAE, ...data.warehouses.map((w) => w.id)];
  const sources = [UAE, ...rows.map((r) => r.warehouse_id)];

  return (
    <div>
      <Label>{t("countryStock.title")}</Label>
      <p className="text-caption text-secondary mb-2">{t("countryStock.hint")}</p>

      {rows.length === 0 ? (
        <p className="text-caption text-secondary mb-2">{t("countryStock.none")}</p>
      ) : (
        <ul className="rounded-card border border-hairline bg-canvas divide-y divide-hairline mb-2">
          {rows.map((r) => {
            const where = place(r);
            const draft = drafts[r.warehouse_id];
            return (
              <li key={r.warehouse_id} className="flex items-center justify-between gap-3 ps-3.5 pe-1 min-h-11">
                <span className="text-subhead truncate">{where}</span>
                <span className="flex items-center gap-1 shrink-0">
                  <input
                    type="text"
                    inputMode="numeric"
                    className="w-24 px-2.5 min-h-11 rounded-card border border-hairline bg-surface text-subhead text-end tabular-nums outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 transition"
                    value={draft ?? String(r.qty)}
                    disabled={busy || r.warehouse_id.startsWith("pending-")}
                    aria-label={t("countryStock.qtyLabel", { place: where })}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.warehouse_id]: e.target.value }))}
                    onBlur={() => void saveRowQty(r)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <Button
                    tier="plain"
                    type="button"
                    className="min-h-11"
                    disabled={busy}
                    onClick={() => setConfirmRemove(r)}
                    aria-label={t("countryStock.removeFrom", { place: where })}
                  >
                    {t("common.remove")}
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {confirmRemove && (
        <div
          role="alertdialog"
          aria-live="polite"
          className="mb-2 rounded-card border border-[--status-warning] bg-[--status-warning]/10 p-3"
        >
          <p className="text-subhead">
            {t("countryStock.removeConfirm", { place: place(confirmRemove), qty: confirmRemove.qty })}
          </p>
          <div className="flex items-center justify-end gap-2 mt-2.5">
            <Button tier="plain" type="button" className="min-h-11" onClick={() => setConfirmRemove(null)}>
              {t("common.cancel")}
            </Button>
            <Button tier="danger" type="button" className="min-h-11" disabled={busy} onClick={() => remove(confirmRemove)}>
              {t("common.remove")}
            </Button>
          </div>
        </div>
      )}

      {!adding && !moving && (
        <div className="flex flex-wrap gap-2">
          <Button tier="tinted" type="button" className="min-h-11" disabled={busy} onClick={openAdd}>
            {t("countryStock.add")}
          </Button>
          {/* Nowhere to move to until there is a warehouse abroad. */}
          {data.warehouses.length > 0 && (
            <Button tier="tinted" type="button" className="min-h-11" disabled={busy} onClick={openMove}>
              {t("countryStock.move")}
            </Button>
          )}
        </div>
      )}

      {adding && (
        <div className="rounded-card border border-hairline bg-canvas p-3">
          <p className="text-subhead font-semibold">{t("countryStock.addTitle")}</p>
          <Label>{t("countryStock.warehouse")}</Label>
          <select
            className={SELECT}
            value={addWarehouse}
            aria-label={t("countryStock.warehouse")}
            onChange={(e) => setAddWarehouse(e.target.value)}
          >
            {unused.map((w) => (
              <option key={w.id} value={w.id}>
                {place(w)}
              </option>
            ))}
            <option value={NEW}>{t("countryStock.newWarehouse")}</option>
          </select>
          {addWarehouse === NEW && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t("countryStock.country")}</Label>
                <TextInput
                  value={addCountry}
                  maxLength={60}
                  placeholder={t("countryStock.countryPlaceholder")}
                  aria-label={t("countryStock.country")}
                  onChange={(e) => setAddCountry(e.target.value)}
                />
              </div>
              <div>
                <Label>{t("countryStock.warehouseName")}</Label>
                <TextInput
                  value={addName}
                  maxLength={80}
                  placeholder={t("countryStock.warehouseNamePlaceholder")}
                  aria-label={t("countryStock.warehouseName")}
                  onChange={(e) => setAddName(e.target.value)}
                />
              </div>
            </div>
          )}
          <Label>{t("countryStock.quantity")}</Label>
          <TextInput
            inputMode="numeric"
            className="tabular-nums"
            value={addQty}
            aria-label={t("countryStock.quantity")}
            onChange={(e) => setAddQty(e.target.value)}
          />
          <div className="flex items-center justify-end gap-2 mt-3">
            <Button tier="plain" type="button" className="min-h-11" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </Button>
            <Button tier="primary" type="button" className="min-h-11" disabled={busy} onClick={saveAdd}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}

      {moving && (
        <div className="rounded-card border border-hairline bg-canvas p-3">
          <p className="text-subhead font-semibold">{t("countryStock.moveTitle")}</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{t("countryStock.moveFrom")}</Label>
              <select
                className={SELECT}
                value={moveFrom}
                aria-label={t("countryStock.moveFrom")}
                onChange={(e) => {
                  const from = e.target.value;
                  setMoveFrom(from);
                  if (moveTo === from) setMoveTo(destinations.find((k) => k !== from) ?? "");
                }}
              >
                {sources.map((k) => (
                  <option key={k} value={k}>
                    {label(k)}
                  </option>
                ))}
              </select>
              <p className="text-caption text-secondary tabular-nums mt-1">
                {t("countryStock.moveAvailable", { have: have(moveFrom) })}
              </p>
            </div>
            <div>
              <Label>{t("countryStock.moveTo")}</Label>
              <select
                className={SELECT}
                value={moveTo}
                aria-label={t("countryStock.moveTo")}
                onChange={(e) => setMoveTo(e.target.value)}
              >
                {destinations
                  .filter((k) => k !== moveFrom)
                  .map((k) => (
                    <option key={k} value={k}>
                      {label(k)}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <Label>{t("countryStock.quantity")}</Label>
          <TextInput
            inputMode="numeric"
            className="tabular-nums"
            value={moveQty}
            aria-label={t("countryStock.quantity")}
            onChange={(e) => setMoveQty(e.target.value)}
          />
          <div className="flex items-center justify-end gap-2 mt-3">
            <Button tier="plain" type="button" className="min-h-11" onClick={() => setMoving(false)}>
              {t("common.cancel")}
            </Button>
            <Button tier="primary" type="button" className="min-h-11" disabled={busy} onClick={saveMove}>
              {t("countryStock.moveConfirm")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
