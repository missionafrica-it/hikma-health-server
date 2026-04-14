import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { uuidv7 } from "uuidv7";
import DrugCatalogue from "@/models/drug-catalogue";
import db from "@/db";
import * as Sentry from "@sentry/tanstackstart-react";
import { Effect } from "effect";

// ─── Types ────────────────────────────────────────────────────────────────────

/** All CSV/XLSX columns as raw strings. */
type RawRow = Record<string, string> & { _source_row: number };

type DrugRow = {
  generic_name: string;
  brand_name?: string;
  form: string;
  route: string;
  dosage_quantity: number;
  dosage_units: string;
  barcode?: string;
  manufacturer?: string;
  sale_price?: number;
  sale_currency?: string;
  min_stock_level?: number;
  max_stock_level?: number;
  is_controlled?: boolean;
  requires_refrigeration?: boolean;
  is_active?: boolean;
  notes?: string;
  _source_row?: number;
};

type ImportPayload = {
  rows: DrugRow[];
  dryRun?: boolean;
};

type ImportResult = {
  success: number;
  created: number;
  updated: number;
  failed: number;
  errors: Array<{ row: number; message: string }>;
};

type PreValidation = {
  errors: Array<{ row: number; message: string }>;
  warnings: string[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const SUPPORTED_HEADERS = [
  "generic_name",
  "brand_name",
  "form",
  "route",
  "dosage_quantity",
  "dosage_units",
  "barcode",
  "manufacturer",
  "sale_price",
  "sale_currency",
  "min_stock_level",
  "max_stock_level",
  "is_controlled",
  "requires_refrigeration",
  "is_active",
  "notes",
] as const;

const HEADER_SET = new Set<string>(SUPPORTED_HEADERS);
const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const BOOLEAN_TRUE = new Set(["true", "yes", "1", "y"]);
const BOOLEAN_FALSE = new Set(["false", "no", "0", "n"]);

// ─── Server functions ─────────────────────────────────────────────────────────

const importDrugCatalogueChunk = createServerFn({ method: "POST" })
  .inputValidator((data: ImportPayload) => data)
  .handler(async ({ data }): Promise<ImportResult> => {
    return Sentry.startSpan({ name: "importDrugCatalogueChunk" }, async () => {
      const rows = data.rows ?? [];
      if (rows.length === 0) {
        return { success: 0, created: 0, updated: 0, failed: 0, errors: [] };
      }
      if (rows.length > 500) {
        throw new Error("Chunk too large. Max 500 rows per request.");
      }

      // Pre-fetch existing drugs for dedup: by barcode and by (generic_name+form+route+dosage_quantity+dosage_units)
      const barcodes = rows
        .map((r) => r.barcode?.trim())
        .filter(Boolean) as string[];

      const existingByBarcode = barcodes.length > 0
        ? await db
            .selectFrom("drug_catalogue")
            .select(["id", "barcode"])
            .where("barcode", "in", barcodes)
            .where("is_deleted", "=", false)
            .execute()
        : [];

      const barcodeToId = new Map<string, string>(
        existingByBarcode.map((d) => [d.barcode!, d.id]),
      );

      let success = 0;
      let created = 0;
      let updated = 0;
      let failed = 0;
      const errors: Array<{ row: number; message: string }> = [];

      for (const row of rows) {
        const rowNumber = row._source_row ?? -1;

        if (data.dryRun) {
          const existingId = row.barcode ? barcodeToId.get(row.barcode.trim()) : undefined;
          success += 1;
          if (existingId) updated += 1;
          else created += 1;
          continue;
        }

        try {
          const existingId = row.barcode
            ? barcodeToId.get(row.barcode.trim())
            : undefined;

          const drug: Partial<DrugCatalogue.ApiDrug> = {
            id: existingId || uuidv7(),
            generic_name: row.generic_name.trim(),
            brand_name: row.brand_name?.trim() || null,
            form: row.form.trim(),
            route: row.route.trim(),
            dosage_quantity: row.dosage_quantity,
            dosage_units: row.dosage_units.trim(),
            barcode: row.barcode?.trim() || null,
            manufacturer: row.manufacturer?.trim() || null,
            sale_price: row.sale_price ?? 0,
            sale_currency: row.sale_currency?.trim() || null,
            min_stock_level: row.min_stock_level ?? 0,
            max_stock_level: row.max_stock_level ?? null,
            is_controlled: row.is_controlled ?? false,
            requires_refrigeration: row.requires_refrigeration ?? false,
            is_active: row.is_active ?? true,
            notes: row.notes?.trim() || null,
            metadata: {},
            is_deleted: false,
          };

          const result = await Effect.runPromise(
            DrugCatalogue.API.upsert(drug),
          );

          if (!result) throw new Error("Upsert returned no result");

          success += 1;
          if (existingId) updated += 1;
          else created += 1;
        } catch (error) {
          failed += 1;
          errors.push({
            row: rowNumber,
            message:
              error instanceof Error
                ? error.message
                : "Failed to import drug row.",
          });
        }
      }

      return { success, created, updated, failed, errors };
    });
  });

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/app/inventory/drug-catalogue/import")({
  component: RouteComponent,
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  values.push(current.trim());
  return values;
}

function parseCsvToRaw(content: string): RawRow[] {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const rows: RawRow[] = [];

  for (let i = 1; i < lines.length; i += 1) {
    const cols = parseCsvLine(lines[i]);
    const record: RawRow = { _source_row: i + 1 };
    headers.forEach((h, idx) => {
      record[h] = (cols[idx] || "").trim();
    });
    rows.push(record);
  }
  return rows;
}

async function parseXlsxToRaw(
  file: File,
): Promise<{ rows: RawRow[]; headers: string[] }> {
  const ExcelJS = (await import("exceljs")).default;
  const buffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], headers: [] };

  const headerCells = (
    sheet.getRow(1).values as Array<string | number | null>
  )
    .slice(1)
    .map((v) => String(v || "").trim().toLowerCase());

  const rows: RawRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const record: RawRow = { _source_row: r };
    headerCells.forEach((h, idx) => {
      const cell = row.getCell(idx + 1).value;
      record[h] =
        cell === null || cell === undefined
          ? ""
          : typeof cell === "object" && "text" in cell
            ? String(cell.text || "")
            : String(cell);
    });
    const values = headerCells.map((h) => record[h] || "");
    if (values.every((v) => v.trim().length === 0)) continue;
    rows.push(record);
  }
  return { rows, headers: headerCells };
}

function parseHeaderListFromCsv(content: string): string[] {
  const firstLine =
    content.split(/\r?\n/).find((l) => l.trim().length > 0) || "";
  return parseCsvLine(firstLine).map((h) => h.trim().toLowerCase());
}

function parseBoolean(value: string): boolean | undefined {
  const v = value.toLowerCase().trim();
  if (BOOLEAN_TRUE.has(v)) return true;
  if (BOOLEAN_FALSE.has(v)) return false;
  return undefined;
}

function parseOptionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = parseFloat(value);
  return isNaN(n) ? undefined : n;
}

function buildDrugRow(raw: RawRow): DrugRow {
  return {
    generic_name: raw.generic_name || "",
    brand_name: raw.brand_name || undefined,
    form: raw.form || "",
    route: raw.route || "",
    dosage_quantity: parseOptionalNumber(raw.dosage_quantity) ?? 0,
    dosage_units: raw.dosage_units || "",
    barcode: raw.barcode || undefined,
    manufacturer: raw.manufacturer || undefined,
    sale_price: parseOptionalNumber(raw.sale_price),
    sale_currency: raw.sale_currency || undefined,
    min_stock_level: parseOptionalNumber(raw.min_stock_level),
    max_stock_level: parseOptionalNumber(raw.max_stock_level),
    is_controlled:
      raw.is_controlled ? parseBoolean(raw.is_controlled) : undefined,
    requires_refrigeration:
      raw.requires_refrigeration
        ? parseBoolean(raw.requires_refrigeration)
        : undefined,
    is_active:
      raw.is_active ? parseBoolean(raw.is_active) : true,
    notes: raw.notes || undefined,
    _source_row: raw._source_row,
  };
}

function validateHeaders(fileHeaders: string[]): string[] {
  const errors: string[] = [];
  const unknown = fileHeaders.filter((h) => h && !HEADER_SET.has(h as any));
  if (unknown.length > 0) {
    errors.push(`Unsupported headers: ${unknown.join(", ")}`);
  }
  if (!fileHeaders.includes("generic_name")) {
    errors.push("Headers must include generic_name.");
  }
  if (!fileHeaders.includes("form")) {
    errors.push("Headers must include form.");
  }
  if (!fileHeaders.includes("route")) {
    errors.push("Headers must include route.");
  }
  if (!fileHeaders.includes("dosage_quantity")) {
    errors.push("Headers must include dosage_quantity.");
  }
  if (!fileHeaders.includes("dosage_units")) {
    errors.push("Headers must include dosage_units.");
  }
  return errors;
}

function preValidateRows(rows: DrugRow[]): PreValidation {
  const errors: Array<{ row: number; message: string }> = [];
  const warnings: string[] = [];
  const barcodeSeen = new Map<string, number>();

  for (const row of rows) {
    const rowNumber = row._source_row ?? -1;

    if (!row.generic_name.trim()) {
      errors.push({ row: rowNumber, message: "generic_name is required." });
    }
    if (!row.form.trim()) {
      errors.push({ row: rowNumber, message: "form is required." });
    }
    if (!row.route.trim()) {
      errors.push({ row: rowNumber, message: "route is required." });
    }
    if (!row.dosage_units.trim()) {
      errors.push({ row: rowNumber, message: "dosage_units is required." });
    }
    if (isNaN(row.dosage_quantity) || row.dosage_quantity < 0) {
      errors.push({
        row: rowNumber,
        message: "dosage_quantity must be a non-negative number.",
      });
    }

    const barcode = row.barcode?.trim();
    if (barcode) {
      const first = barcodeSeen.get(barcode);
      if (first) {
        errors.push({
          row: rowNumber,
          message: `Duplicate barcode "${barcode}" (also at row ${first}).`,
        });
      } else {
        barcodeSeen.set(barcode, rowNumber);
      }
    }
  }

  if (rows.length > 2000) {
    warnings.push(
      "Large file detected. Validate first and import during off-peak hours.",
    );
  }

  return { errors, warnings };
}

function createErrorCsv(
  errors: Array<{ row: number; message: string }>,
): string {
  const header = "row,error\n";
  const body = errors
    .map((e) => `${e.row},"${String(e.message).replaceAll('"', '""')}"`)
    .join("\n");
  return header + body;
}

function createTemplateCsv(): string {
  const headers = SUPPORTED_HEADERS.join(",");
  const sample = [
    "Amoxicillin",
    "Amoxil",
    "capsule",
    "oral",
    "500",
    "mg",
    "BARCODE-001",
    "GSK",
    "2.50",
    "USD",
    "100",
    "1000",
    "false",
    "false",
    "true",
    "Broad-spectrum antibiotic",
  ].join(",");
  return `${headers}\n${sample}\n`;
}

async function createTemplateXlsxBlob(): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("drug_catalogue_import_template");
  sheet.addRow([...SUPPORTED_HEADERS]);
  sheet.addRow([
    "Amoxicillin",
    "Amoxil",
    "capsule",
    "oral",
    "500",
    "mg",
    "BARCODE-001",
    "GSK",
    "2.50",
    "USD",
    "100",
    "1000",
    "false",
    "false",
    "true",
    "Broad-spectrum antibiotic",
  ]);
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Component ────────────────────────────────────────────────────────────────

function RouteComponent() {
  const [fileName, setFileName] = useState("");
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [fileHeaderErrors, setFileHeaderErrors] = useState<string[]>([]);
  const [preValidation, setPreValidation] = useState<PreValidation>({
    errors: [],
    warnings: [],
  });

  const rows = useMemo(() => rawRows.map(buildDrugRow), [rawRows]);
  const preview = useMemo(() => rows.slice(0, 8), [rows]);
  const hasRows = rows.length > 0;

  const onFileChange = async (file?: File | null) => {
    if (!file) return;
    setFileName(file.name);
    let raw: RawRow[] = [];
    let headers: string[] = [];

    if (file.name.toLowerCase().endsWith(".csv")) {
      const content = await file.text();
      headers = parseHeaderListFromCsv(content);
      raw = parseCsvToRaw(content);
    } else if (
      file.name.toLowerCase().endsWith(".xlsx") ||
      file.name.toLowerCase().endsWith(".xlsm")
    ) {
      const result = await parseXlsxToRaw(file);
      raw = result.rows;
      headers = result.headers;
    } else {
      toast.error("Unsupported file type. Please upload CSV or XLSX.");
      return;
    }

    const headerErrors = validateHeaders(headers);
    setFileHeaderErrors(headerErrors);

    const mapped = raw.map(buildDrugRow);
    const pre = preValidateRows(mapped);
    setPreValidation(pre);
    setRawRows(raw);
    setLastResult(null);

    if (headerErrors.length > 0) {
      toast.error("File header validation failed.");
      return;
    }
    if (pre.errors.length > 0) {
      toast.error(
        `Pre-validation found ${pre.errors.length} issue(s). Fix file before import.`,
      );
      return;
    }
    if (raw.length === 0) {
      toast.error("No data rows found.");
      return;
    }
    toast.success(`Loaded ${raw.length} rows from ${file.name}`);
  };

  const runImport = async () => {
    if (!hasRows || isImporting) return;
    setIsImporting(true);
    setLastResult(null);

    try {
      const chunkSize = 200;
      let aggregate: ImportResult = {
        success: 0,
        created: 0,
        updated: 0,
        failed: 0,
        errors: [],
      };

      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const res = await importDrugCatalogueChunk({
          data: { rows: chunk, dryRun },
        });
        aggregate = {
          success: aggregate.success + res.success,
          created: aggregate.created + res.created,
          updated: aggregate.updated + res.updated,
          failed: aggregate.failed + res.failed,
          errors: [...aggregate.errors, ...res.errors],
        };
      }

      setLastResult(aggregate);
      if (aggregate.failed > 0) {
        toast.warning(
          `${dryRun ? "Validation" : "Import"} completed with ${aggregate.failed} failed rows.`,
        );
      } else {
        toast.success(
          `${dryRun ? "Validation" : "Import"} completed successfully (${aggregate.success} rows).`,
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Import failed unexpectedly.",
      );
    } finally {
      setIsImporting(false);
    }
  };

  const downloadErrorCsv = () => {
    if (!lastResult || lastResult.errors.length === 0) return;
    downloadBlob(
      new Blob([createErrorCsv(lastResult.errors)], {
        type: "text/csv;charset=utf-8;",
      }),
      "drug-catalogue-import-errors.csv",
    );
  };

  return (
    <div className="space-y-6 py-4">
      <div>
        <h1 className="text-2xl font-semibold">Bulk Import Drug Catalogue</h1>
        <p className="text-muted-foreground mt-2">
          Upload CSV or XLSX to add or update medicines in the drug catalogue.
          Existing drugs are matched by barcode when provided, otherwise a new
          entry is created.
        </p>
      </div>

      {/* ── Required headers info ── */}
      <Alert>
        <AlertTitle>Required file headers</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            Required:{" "}
            <code>generic_name, form, route, dosage_quantity, dosage_units</code>
          </p>
          <p>
            Optional:{" "}
            <code>
              brand_name, barcode, manufacturer, sale_price, sale_currency,
              min_stock_level, max_stock_level, is_controlled,
              requires_refrigeration, is_active, notes
            </code>
          </p>
          <p className="text-xs">
            Boolean fields accept: <code>true/false</code>, <code>yes/no</code>
            , <code>1/0</code>
          </p>
        </AlertDescription>
      </Alert>

      {/* ── Templates ── */}
      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              downloadBlob(
                new Blob([createTemplateCsv()], {
                  type: "text/csv;charset=utf-8;",
                }),
                "drug-catalogue-import-template.csv",
              )
            }
          >
            Download CSV Template
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              const blob = await createTemplateXlsxBlob();
              downloadBlob(blob, "drug-catalogue-import-template.xlsx");
            }}
          >
            Download XLSX Template
          </Button>
        </CardContent>
      </Card>

      {/* ── Upload ── */}
      <Card>
        <CardHeader>
          <CardTitle>Upload File</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="file"
            accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => onFileChange(e.target.files?.[0] || null)}
          />
          {fileHeaderErrors.length > 0 && (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {fileHeaderErrors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          )}
          <div className="text-sm text-muted-foreground">
            {fileName ? `Loaded file: ${fileName}` : "No file selected"}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            Validate only (dry run)
          </label>
          <Button
            onClick={runImport}
            disabled={
              !hasRows ||
              isImporting ||
              fileHeaderErrors.length > 0 ||
              preValidation.errors.length > 0
            }
          >
            {isImporting
              ? "Processing..."
              : dryRun
                ? "Validate Rows"
                : "Import Drugs"}
          </Button>
          {preValidation.warnings.length > 0 && (
            <div className="text-sm text-amber-700">
              {preValidation.warnings.map((w) => (
                <div key={w}>{w}</div>
              ))}
            </div>
          )}
          {preValidation.errors.length > 0 && (
            <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700 max-h-48 overflow-auto">
              {preValidation.errors.slice(0, 200).map((e, idx) => (
                <div key={`${e.row}-${idx}`}>
                  Row {e.row}: {e.message}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Preview ── */}
      {hasRows && (
        <Card>
          <CardHeader>
            <CardTitle>Preview ({rows.length} rows)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-2 pr-4">Generic Name</th>
                    <th className="text-left py-2 pr-4">Brand Name</th>
                    <th className="text-left py-2 pr-4">Form</th>
                    <th className="text-left py-2 pr-4">Route</th>
                    <th className="text-left py-2 pr-4">Dosage</th>
                    <th className="text-left py-2 pr-4">Barcode</th>
                    <th className="text-left py-2 pr-4">Controlled</th>
                    <th className="text-left py-2 pr-4">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} className="border-b">
                      <td className="py-2 pr-4">{r.generic_name || "-"}</td>
                      <td className="py-2 pr-4">{r.brand_name || "-"}</td>
                      <td className="py-2 pr-4">{r.form || "-"}</td>
                      <td className="py-2 pr-4">{r.route || "-"}</td>
                      <td className="py-2 pr-4">
                        {r.dosage_quantity} {r.dosage_units}
                      </td>
                      <td className="py-2 pr-4">{r.barcode || "-"}</td>
                      <td className="py-2 pr-4">
                        {r.is_controlled ? "Yes" : "No"}
                      </td>
                      <td className="py-2 pr-4">
                        {r.is_active !== false ? "Yes" : "No"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Results ── */}
      {lastResult && (
        <Card>
          <CardHeader>
            <CardTitle>
              {dryRun ? "Validation Result" : "Import Result"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>Success: {lastResult.success}</div>
              <div>Created: {lastResult.created}</div>
              <div>Updated: {lastResult.updated}</div>
              <div>Failed: {lastResult.failed}</div>
            </div>
            {lastResult.errors.length > 0 && (
              <div className="space-y-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={downloadErrorCsv}
                >
                  Download Error CSV
                </Button>
                <div className="max-h-64 overflow-auto rounded border p-3 text-sm">
                  {lastResult.errors.slice(0, 200).map((err, idx) => (
                    <div key={`${err.row}-${idx}`} className="py-1">
                      Row {err.row}: {err.message}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
