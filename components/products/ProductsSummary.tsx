"use client";

import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { formatAed } from "@/lib/money";
import { monthBounds } from "@/lib/queries/dashboard";
import { fetchProductSummary, type ProductSummary } from "@/lib/queries/products";
import { Card } from "@/components/ui/Card";
import { Skeleton } from "@/components/ui/Empty";
import Button from "@/components/ui/Button";

const COUNT = new Intl.NumberFormat("en-AE");
const count = (n: number) => COUNT.format(n);

// The summary card at the top of Products (owner, 2026-10-10): what the
// stock is worth, how much of the catalogue is on the shelf, and what sold
// this month. Manager-only — the caller renders it for a manager, and the
// route behind it refuses anyone else.
//
// `refreshKey` changes when this page changes the catalogue (a save, an
// import, a stock link), so the figures follow the list under them.
export default function ProductsSummary({ refreshKey }: { refreshKey: number }) {
  const [summary, setSummary] = useState<ProductSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetchProductSummary(monthBounds())
      .then((s) => !cancelled && setSummary(s))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [refreshKey, attempt]);

  // A refresh that fails keeps the figures already on screen.
  if (failed && !summary) {
    return (
      <Card className="p-4 mb-5 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-subhead text-secondary">{t("products.summaryFailed")}</span>
        <Button tier="plain" onClick={() => setAttempt((n) => n + 1)}>
          {t("common.retry")}
        </Button>
      </Card>
    );
  }

  const stock = summary?.stock;
  const month = summary?.month;

  return (
    <Card className="p-4 mb-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        {/* One to a row on a phone: a money figure is never cut short. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Tile
            label={t("products.summaryStockValue")}
            value={stock && formatAed(stock.valueAtCost)}
            sub={
              stock &&
              (stock.inStockNoCost > 0
                ? t("products.summaryNoCost", { n: count(stock.inStockNoCost) })
                : t("products.summaryAtCost"))
            }
          />
          <Tile
            label={t("products.summarySellingValue")}
            value={stock && formatAed(stock.valueAtPrice)}
            sub={stock && t("products.summaryBeforeVat")}
          />
          <Tile
            label={t("products.summaryInStock")}
            value={stock && t("products.summaryOfArticles", { n: count(stock.inStock), total: count(stock.articles) })}
            sub={
              stock &&
              t("products.summaryPiecesOut", { pieces: count(stock.units), out: count(stock.outOfStock) })
            }
          />
          <Tile
            label={t("products.summarySoldThisMonth")}
            value={month && formatAed(month.value)}
            sub={
              month &&
              t("products.summaryPiecesArticles", { pieces: count(month.units), articles: count(month.articlesSold) })
            }
          />
        </div>

        <div className="rounded-card border border-hairline p-3 min-w-0">
          <div className="text-caption font-semibold text-secondary mb-2">{t("products.summaryMostSold")}</div>
          {!month ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-6 w-full" style={{ animationDelay: `${i * 90}ms` }} />
              ))}
            </div>
          ) : month.top.length === 0 ? (
            <div className="text-subhead text-secondary py-2">{t("products.summaryNothingSold")}</div>
          ) : (
            <ol className="flex flex-col">
              {month.top.map((row, i) => (
                <li
                  key={row.productId ?? row.sku}
                  className="flex items-baseline gap-3 py-1.5 border-b border-hairline last:border-b-0"
                >
                  <span className="text-caption text-secondary tabular-nums w-4 shrink-0">{i + 1}</span>
                  {/* The name sits beside the SKU, and under it on a phone. */}
                  <span className="min-w-0 flex-1 flex flex-wrap items-baseline gap-x-2">
                    <span className="text-subhead font-semibold">{row.sku}</span>
                    {row.name && (
                      <span className="text-caption text-secondary truncate min-w-0 basis-full sm:basis-0 sm:grow">
                        {row.name}
                      </span>
                    )}
                  </span>
                  <span className="text-subhead font-semibold tabular-nums shrink-0">
                    {t("products.summaryPieces", { n: count(row.units) })}
                  </span>
                  <span className="text-caption text-secondary tabular-nums shrink-0 sm:w-28 text-end">
                    {formatAed(row.value)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Card>
  );
}

function Tile({ label, value, sub }: { label: string; value?: string; sub?: string }) {
  return (
    <div className="rounded-card border border-hairline p-3 min-w-0">
      <div className="text-caption text-secondary">{label}</div>
      {value === undefined ? (
        <>
          <Skeleton className="h-7 w-3/4 mt-1.5" />
          <Skeleton className="h-4 w-1/2 mt-1.5" />
        </>
      ) : (
        <>
          <div className="text-title font-bold mt-1 tabular-nums">{value}</div>
          {sub && <div className="text-caption text-secondary mt-0.5 tabular-nums">{sub}</div>}
        </>
      )}
    </div>
  );
}
