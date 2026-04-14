import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import db from "@/db";
import DrugBatches from "@/models/drug-batches";
import ClinicInventory from "@/models/clinic-inventory";
import { getAllClinics } from "@/lib/server-functions/clinics";
import { Result } from "@/lib/result";
import * as Sentry from "@sentry/tanstackstart-react";

// ─── Types ────────────────────────────────────────────────────────────────────

type RawRow = Record<string, string> & { _source_row: number };

type StockRow = {
  generic_name: string;
  batch_number: string;
  expiry_date: string;
  quantity: number;
  received_date?: string;
  supplier_name?: string;
  purchase_price?: number;
  purchase_currency?: string;
  manufacture_date?: string;
  _source_row?: number;
};

type ImportPayload = {
  rows: StockRow[];
  clinicId: string;
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
  "batch_number",
  "expiry_date",
  "quantity",
  "received_date",
  "supplier_name",
  "purchase_price",
  "purchase_currency",
  "manufacture_date",
] as const;

const HEADER_SET = new Set<string>(SUPPORTED_HEADERS);
const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ─── Server function ──────────────────────────────────────────────────────────

const importStockChunk = createServerFn({ method: "POST" })
  .inputValidator((data: ImportPayload) => data)
  .handler(async ({ data }): Promise<ImportResult> => {
    return Sentry.startSpan({ name: "importStockChunk" }, async () => {
      const { rows, clinicId } = data;

      if (!clinicId) throw new Error("clinicId is required.");
      if (rows.length === 0) {
        return { success: 0, created: 0, updated: 0, failed: 0, errors: [] };
      }
      if (rows.length > 500) {
        throw new Error("Chunk too large. Max 500 rows per request.");
      }

      // Validate clinic exists
      const clinic = await db
        .selectFrom("clinics")
        .select("id")
        .where("id", "=", clinicId)
        .where("is_deleted", "=", false)
        .executeTakeFirst();
      if (!clinic) throw new Error(`Unknown clinic id: "${clinicId}".`);

      // Look up all required drugs in one query
      const genericNames = Array.from(
        new Set(rows.map((r) => r.generic_name.trim().toLowerCase())),
      );
      const drugs = await db
        .selectFrom("drug_catalogue")
        .select(["id", "generic_name"])
        .where((eb) =>
          eb(
            eb.fn("lower", ["generic_name"]),
            "in",
            genericNames,
          ),
        )
        .where("is_deleted", "=", false)
        .where("is_active", "=", true)
        .execute();

      const drugByName = new Map<string, string>(
        drugs.map((d) => [d.generic_name.trim().toLowerCase(), d.id]),
      );

      let success = 0;
      let created = 0;
      let updated = 0;
      let failed = 0;
      const errors: Array<{ row: number; message: string }> = [];

      for (const row of rows) {
        const rowNumber = row._source_row ?? -1;

        const drugId = drugByName.get(row.generic_name.trim().toLowerCase());
        if (!drugId) {
          failed += 1;
          errors.push({
            row: rowNumber,
            message: `Drug not found in catalogue: "${row.generic_name}". Add it to the drug catalogue first.`,
          });
          continue;
        }

        if (data.dryRun) {
          success += 1;
          created += 1;
          continue;
        }

        try {
          const receivedDate = row.received_date || new Date().toISOString().split("T")[0];
          const expiryDate = new Date(row.expiry_date);

          // Upsert the batch (conflict on batch_number + drug_id increments qty)
          const batchResult = await DrugBatches.API.upsert({
            drug_id: drugId,
            batch_number: row.batch_number.trim(),
            expiry_date: expiryDate,
            manufacture_date: row.manufacture_date
              ? new Date(row.manufacture_date)
              : null,
            quantity_received: row.quantity,
            quantity_remaining: row.quantity,
            supplier_name: row.supplier_name?.trim() || null,
            purchase_price: row.purchase_price ?? null,
            purchase_currency: row.purchase_currency?.trim() || null,
            received_date: new Date(receivedDate),
            is_quarantined: false,
            metadata: {},
            is_deleted: false,
          });

          // Now update clinic inventory
          await ClinicInventory.API.updateQuantity({
            clinicId,
            drugId,
            batchId: batchResult.id,
            batchNumber: row.batch_number.trim(),
            batchExpiryDate: expiryDate,
            quantityChange: row.quantity,
            transactionType: "received",
            reason: "bulk_import",
          });

          success += 1;
          created += 1;
        } catch (error) {
          failed += 1;
          errors.push({
            row: rowNumber,
            message:
              error instanceof Error
                ? error.message
                : "Failed to import stock row.",
          });
        }
      }

      return { success, created, updated, failed, errors };
    });
  });

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute(
  "/app/inventory/clinic-inventory/import",
)({
  component: RouteComponent,
  loader: async () => {
    const clinics = Result.getOrElse(await getAllClinics(), []);
    return { clinics };
  },
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

function buildStockRow(raw: RawRow): StockRow {
  const qty = parseFloat(raw.quantity || "0");
  return {
    generic_name: raw.generic_name || "",
    batch_number: raw.batch_number || "",
    expiry_date: raw.expiry_date || "",
    quantity: isNaN(qty) ? 0 : Math.round(qty),
    received_date: raw.received_date || undefined,
    supplier_name: raw.supplier_name || undefined,
    purchase_price: raw.purchase_price
      ? parseFloat(raw.purchase_price)
      : undefined,
    purchase_currency: raw.purchase_currency || undefined,
    manufacture_date: raw.manufacture_date || undefined,
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
  if (!fileHeaders.includes("batch_number")) {
    errors.push("Headers must include batch_number.");
  }
  if (!fileHeaders.includes("expiry_date")) {
    errors.push("Headers must include expiry_date.");
  }
  if (!fileHeaders.includes("quantity")) {
    errors.push("Headers must include quantity.");
  }
  return errors;
}

function preValidateRows(rows: StockRow[]): PreValidation {
  const errors: Array<{ row: number; message: string }> = [];
  const warnings: string[] = [];

  for (const row of rows) {
    const rowNumber = row._source_row ?? -1;

    if (!row.generic_name.trim()) {
      errors.push({ row: rowNumber, message: "generic_name is required." });
    }
    if (!row.batch_number.trim()) {
      errors.push({ row: rowNumber, message: "batch_number is required." });
    }
    if (!row.expiry_date.trim()) {
      errors.push({ row: rowNumber, message: "expiry_date is required." });
    } else if (!STRICT_DATE_REGEX.test(row.expiry_date)) {
      errors.push({
        row: rowNumber,
        message: "expiry_date must be in YYYY-MM-DD format.",
      });
    }
    if (isNaN(row.quantity) || row.quantity <= 0) {
      errors.push({
        row: rowNumber,
        message: "quantity must be a positive number.",
      });
    }
    if (
      row.received_date &&
      !STRICT_DATE_REGEX.test(row.received_date)
    ) {
      errors.push({
        row: rowNumber,
        message: "received_date must be in YYYY-MM-DD format.",
      });
    }
    if (
      row.manufacture_date &&
      !STRICT_DATE_REGEX.test(row.manufacture_date)
    ) {
      errors.push({
        row: rowNumber,
        message: "manufacture_date must be in YYYY-MM-DD format.",
      });
    }
    if (
      row.purchase_price !== undefined &&
      isNaN(row.purchase_price)
    ) {
      errors.push({
        row: rowNumber,
        message: "purchase_price must be a valid number.",
      });
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
  return (
    "row,error\n" +
    errors
      .map((e) => `${e.row},"${String(e.message).replaceAll('"', '""')}"`)
      .join("\n")
  );
}

function createTemplateCsv(): string {
  const today = new Date().toISOString().split("T")[0];
  return (
    SUPPORTED_HEADERS.join(",") +
    "\n" +
    [
      "Amoxicillin",
      "BATCH-2025-001",
      "2027-06-30",
      "500",
      today,
      "MedSupply Co",
      "1.20",
      "USD",
      "2025-01-15",
    ].join(",") +
    "\n"
  );
}

async function createTemplateXlsxBlob(): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const today = new Date().toISOString().split("T")[0];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("stock_import_template");
  sheet.addRow([...SUPPORTED_HEADERS]);
  sheet.addRow([
    "Amoxicillin",
    "BATCH-2025-001",
    "2027-06-30",
    "500",
    today,
    "MedSupply Co",
    "1.20",
    "USD",
    "2025-01-15",
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
  const { clinics } = Route.useLoaderData();

  const [selectedClinicId, setSelectedClinicId] = useState("");
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

  const rows = useMemo(() => rawRows.map(buildStockRow), [rawRows]);
  const preview = useMemo(() => rows.slice(0, 8), [rows]);
  const hasRows = rows.length > 0;
  const hasClinic = selectedClinicId.length > 0;

  const selectedClinicName =
    clinics.find((c) => c.id === selectedClinicId)?.name ?? "";

  const onClinicChange = (clinicId: string) => {
    setSelectedClinicId(clinicId);
    setFileName("");
    setRawRows([]);
    setLastResult(null);
    setFileHeaderErrors([]);
    setPreValidation({ errors: [], warnings: [] });
  };

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

    const mapped = raw.map(buildStockRow);
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
    if (!hasRows || !hasClinic || isImporting) return;
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
        const res = await importStockChunk({
          data: { rows: chunk, clinicId: selectedClinicId, dryRun },
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
      "stock-import-errors.csv",
    );
  };

  return (
    <div className="space-y-6 py-4">
      <div>
        <h1 className="text-2xl font-semibold">Bulk Import Stock</h1>
        <p className="text-muted-foreground mt-2">
          Upload CSV or XLSX to receive stock into a clinic's inventory. Drugs
          must already exist in the drug catalogue — they are matched by{" "}
          <code>generic_name</code>. Each row creates or updates a batch and
          records a stock receipt transaction.
        </p>
      </div>

      {/* ── Step 1: Clinic selector ── */}
      <Card>
        <CardHeader>
          <CardTitle>Step 1 — Select Clinic</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="clinic-select">Clinic</Label>
          <Select value={selectedClinicId} onValueChange={onClinicChange}>
            <SelectTrigger id="clinic-select" className="w-72">
              <SelectValue placeholder="Choose a clinic…" />
            </SelectTrigger>
            <SelectContent>
              {clinics.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {/* ── Required headers info ── */}
      <Alert>
        <AlertTitle>Required file headers</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>
            Required:{" "}
            <code>generic_name, batch_number, expiry_date, quantity</code>
          </p>
          <p>
            Optional:{" "}
            <code>
              received_date, supplier_name, purchase_price, purchase_currency,
              manufacture_date
            </code>
          </p>
          <p className="text-xs">
            Dates must use <code>YYYY-MM-DD</code> format.{" "}
            <code>generic_name</code> must exactly match a drug in the
            catalogue (case-insensitive). <code>received_date</code> defaults to
            today if omitted.
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
                "stock-import-template.csv",
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
              downloadBlob(blob, "stock-import-template.xlsx");
            }}
          >
            Download XLSX Template
          </Button>
        </CardContent>
      </Card>

      {/* ── Step 2: Upload ── */}
      <Card>
        <CardHeader>
          <CardTitle>Step 2 — Upload File</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!hasClinic && (
            <p className="text-sm text-amber-700">
              Please select a clinic above before uploading a file.
            </p>
          )}
          <Input
            type="file"
            accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={!hasClinic}
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
              !hasClinic ||
              isImporting ||
              fileHeaderErrors.length > 0 ||
              preValidation.errors.length > 0
            }
          >
            {isImporting
              ? "Processing..."
              : dryRun
                ? "Validate Rows"
                : `Import Stock into ${selectedClinicName || "Clinic"}`}
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
                    <th className="text-left py-2 pr-4">Batch No.</th>
                    <th className="text-left py-2 pr-4">Expiry Date</th>
                    <th className="text-left py-2 pr-4">Quantity</th>
                    <th className="text-left py-2 pr-4">Received Date</th>
                    <th className="text-left py-2 pr-4">Supplier</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} className="border-b">
                      <td className="py-2 pr-4">{r.generic_name || "-"}</td>
                      <td className="py-2 pr-4">{r.batch_number || "-"}</td>
                      <td className="py-2 pr-4">{r.expiry_date || "-"}</td>
                      <td className="py-2 pr-4">{r.quantity}</td>
                      <td className="py-2 pr-4">
                        {r.received_date || "(today)"}
                      </td>
                      <td className="py-2 pr-4">{r.supplier_name || "-"}</td>
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
