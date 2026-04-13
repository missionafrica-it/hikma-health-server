import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
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
import { uuidv7 } from "uuidv7";
import db from "@/db";
import { createServerCaller } from "@/integrations/trpc/router";
import { getAllClinics } from "@/lib/server-functions/clinics";
import PatientRegistrationForm from "@/models/patient-registration-form";
import { Result } from "@/lib/result";

// ─── Types ────────────────────────────────────────────────────────────────────

type AdditionalAttribute = {
  attribute_id: string;
  attribute: string;
  number_value?: number | null;
  string_value?: string | null;
  date_value?: string | null;
  boolean_value?: boolean | null;
};

/** All CSV/XLSX columns as raw strings, keyed by lowercased header name. */
type RawRow = Record<string, string> & { _source_row: number };

/** Typed patient row ready to send to the server. */
type CsvRow = {
  given_name?: string;
  surname?: string;
  date_of_birth?: string;
  sex?: string;
  citizenship?: string;
  hometown?: string;
  phone?: string;
  camp?: string;
  government_id?: string;
  external_patient_id?: string;
  _source_row?: number;
  additional_attributes?: AdditionalAttribute[];
};

type ImportPayload = {
  rows: CsvRow[];
  clinicId?: string | null;
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

const SUPPORTED_BASE_HEADERS = [
  "given_name",
  "surname",
  "date_of_birth",
  "sex",
  "citizenship",
  "hometown",
  "phone",
  "camp",
  "government_id",
  "external_patient_id",
] as const;

const BASE_HEADER_SET = new Set<string>(SUPPORTED_BASE_HEADERS);
const ALLOWED_SEX_VALUES = new Set(["male", "female", "other", "unknown"]);
const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// ─── Server functions ─────────────────────────────────────────────────────────

const getAllRegistrationForms = createServerFn({ method: "GET" }).handler(
  async () => PatientRegistrationForm.getAll(),
);

const importPatientsChunk = createServerFn({ method: "POST" })
  .inputValidator((data: ImportPayload) => data)
  .handler(async ({ data }): Promise<ImportResult> => {
    const token = getCookie("token");
    if (!token) throw new Error("Unauthorized");

    const rows = data.rows ?? [];
    if (rows.length === 0) {
      return { success: 0, created: 0, updated: 0, failed: 0, errors: [] };
    }
    if (rows.length > 1000) {
      throw new Error("Chunk too large. Max 1000 rows per request.");
    }

    // Validate the selected clinic once for the whole chunk.
    const clinicId = (data.clinicId || "").trim() || null;
    if (clinicId) {
      const clinic = await db
        .selectFrom("clinics")
        .select("id")
        .where("id", "=", clinicId)
        .where("is_deleted", "=", false)
        .executeTakeFirst();
      if (!clinic) throw new Error(`Unknown clinic id: "${clinicId}".`);
    }

    const caller = createServerCaller({ authHeader: `Bearer ${token}` });

    // Build dedup lookup maps for this chunk.
    const externalIds = Array.from(
      new Set(
        rows
          .map((r) => (r.external_patient_id || "").trim())
          .filter((v) => v.length > 0),
      ),
    );
    const governmentIds = Array.from(
      new Set(
        rows
          .map((r) => (r.government_id || "").trim())
          .filter((v) => v.length > 0),
      ),
    );

    const existingPatients =
      externalIds.length > 0 || governmentIds.length > 0
        ? await db
            .selectFrom("patients")
            .select(["id", "external_patient_id", "government_id"])
            .where((eb) =>
              eb.or([
                externalIds.length > 0
                  ? eb("external_patient_id", "in", externalIds)
                  : eb("id", "=", "__none__"),
                governmentIds.length > 0
                  ? eb("government_id", "in", governmentIds)
                  : eb("id", "=", "__none__"),
              ]),
            )
            .where("is_deleted", "=", false)
            .execute()
        : [];

    const byExternal = new Map<string, string>();
    const byGovernment = new Map<string, string>();
    for (const p of existingPatients) {
      if (p.external_patient_id)
        byExternal.set(p.external_patient_id.trim(), p.id);
      if (p.government_id) byGovernment.set(p.government_id.trim(), p.id);
    }

    let success = 0;
    let created = 0;
    let updated = 0;
    let failed = 0;
    const errors: Array<{ row: number; message: string }> = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const rowNumber = row._source_row ?? i + 2;
      const givenName = (row.given_name || "").trim();
      const surname = (row.surname || "").trim();
      const externalId = (row.external_patient_id || "").trim();
      const governmentId = (row.government_id || "").trim();

      if (!givenName && !surname) {
        failed += 1;
        errors.push({
          row: rowNumber,
          message: "Either given_name or surname is required.",
        });
        continue;
      }

      const existingId =
        (externalId ? byExternal.get(externalId) : undefined) ||
        (governmentId ? byGovernment.get(governmentId) : undefined);
      const patientId = existingId || uuidv7();

      const dob = (row.date_of_birth || "").trim();
      if (dob && !STRICT_DATE_REGEX.test(dob)) {
        failed += 1;
        errors.push({
          row: rowNumber,
          message: "Invalid date_of_birth format. Use strict YYYY-MM-DD.",
        });
        continue;
      }
      if (dob && Number.isNaN(new Date(`${dob}T00:00:00Z`).getTime())) {
        failed += 1;
        errors.push({
          row: rowNumber,
          message: "Invalid date_of_birth. Use YYYY-MM-DD.",
        });
        continue;
      }

      const sex = (row.sex || "").trim().toLowerCase();
      if (sex && !ALLOWED_SEX_VALUES.has(sex)) {
        failed += 1;
        errors.push({
          row: rowNumber,
          message: `Invalid sex value "${row.sex}". Allowed: male, female, other, unknown.`,
        });
        continue;
      }

      if (data.dryRun) {
        success += 1;
        if (existingId) updated += 1;
        else created += 1;
        continue;
      }

      try {
        await caller.register_patient({
          patient: {
            id: patientId,
            given_name: givenName || null,
            surname: surname || null,
            date_of_birth: dob || null,
            sex: sex || null,
            citizenship: (row.citizenship || "").trim() || null,
            hometown: (row.hometown || "").trim() || null,
            phone: (row.phone || "").trim() || null,
            camp: (row.camp || "").trim() || null,
            government_id: governmentId || null,
            external_patient_id: externalId || null,
            primary_clinic_id: clinicId,
            additional_data: {},
            metadata: {},
            photo_url: null,
            updated_at: Date.now(),
            created_at: Date.now(),
          },
          additional_attributes: row.additional_attributes ?? [],
        });
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
              : "Failed to import patient row.",
        });
      }
    }

    return { success, created, updated, failed, errors };
  });

// ─── Route ────────────────────────────────────────────────────────────────────

export const Route = createFileRoute("/app/patients/import")({
  component: RouteComponent,
  loader: async () => {
    const [clinicsResult, forms] = await Promise.all([
      getAllClinics(),
      getAllRegistrationForms(),
    ]);
    const clinics = Result.getOrElse(clinicsResult, []);
    return { clinics, forms };
  },
});

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/** Hand-rolled CSV line parser that handles quoted fields and escaped quotes. */
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

/** Parse a CSV file into raw rows (all columns preserved as strings). */
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

/** Parse an XLSX/XLSM file into raw rows (all columns preserved as strings). */
async function parseXlsxToRaw(file: File): Promise<{ rows: RawRow[]; headers: string[] }> {
  const ExcelJS = (await import("exceljs")).default;
  const buffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], headers: [] };

  const headerCells = (sheet.getRow(1).values as Array<string | number | null>)
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

/**
 * Map a raw row's custom-field columns into typed AdditionalAttribute objects,
 * using the field definitions from the active registration form.
 */
function mapRowToAdditionalAttributes(
  raw: RawRow,
  customFields: PatientRegistrationForm.Field[],
): AdditionalAttribute[] {
  const attrs: AdditionalAttribute[] = [];
  for (const field of customFields) {
    const rawValue = (raw[field.column.toLowerCase()] || "").trim();
    if (!rawValue) continue;

    const attr: AdditionalAttribute = {
      attribute_id: field.id,
      attribute: field.column,
    };

    switch (field.fieldType) {
      case "number": {
        const num = parseFloat(rawValue);
        if (!isNaN(num)) attr.number_value = num;
        break;
      }
      case "boolean":
        attr.boolean_value =
          rawValue.toLowerCase() === "true" ||
          rawValue === "1" ||
          rawValue.toLowerCase() === "yes";
        break;
      case "date":
        attr.date_value = rawValue;
        break;
      default:
        attr.string_value = rawValue;
    }
    attrs.push(attr);
  }
  return attrs;
}

/** Build a typed CsvRow from a raw row, mapping custom field columns as well. */
function buildCsvRow(
  raw: RawRow,
  customFields: PatientRegistrationForm.Field[],
): CsvRow {
  return {
    given_name: raw.given_name,
    surname: raw.surname,
    date_of_birth: raw.date_of_birth,
    sex: raw.sex,
    citizenship: raw.citizenship,
    hometown: raw.hometown,
    phone: raw.phone,
    camp: raw.camp,
    government_id: raw.government_id,
    external_patient_id: raw.external_patient_id,
    _source_row: raw._source_row,
    additional_attributes: mapRowToAdditionalAttributes(raw, customFields),
  };
}

/**
 * Find the most relevant registration form for the selected clinic and return
 * only the non-base, non-deleted custom fields.
 */
function getCustomFieldsForClinic(
  clinicId: string | null,
  forms: PatientRegistrationForm.EncodedT[],
): PatientRegistrationForm.Field[] {
  const activeForms = forms.filter((f) => !f.is_deleted);
  // Prefer a clinic-specific form, fall back to the most recently updated global form.
  let form =
    clinicId
      ? (activeForms.find((f) => f.clinic_id === clinicId) ?? undefined)
      : undefined;
  if (!form) {
    form = [...activeForms].sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )[0];
  }
  if (!form) return [];
  return form.fields.filter((f) => !f.baseField && !f.deleted);
}

/**
 * Validate file headers against the known base columns plus any custom field
 * columns for the selected clinic.
 */
function validateHeaders(
  fileHeaders: string[],
  customFieldColumns: string[],
): string[] {
  const errors: string[] = [];
  const allKnown = new Set([
    ...BASE_HEADER_SET,
    ...customFieldColumns.map((c) => c.toLowerCase()),
  ]);
  const unknown = fileHeaders.filter((h) => h && !allKnown.has(h));
  if (unknown.length > 0) {
    errors.push(`Unsupported headers: ${unknown.join(", ")}`);
  }
  if (
    !fileHeaders.includes("given_name") ||
    !fileHeaders.includes("surname")
  ) {
    errors.push("Headers must include both given_name and surname columns.");
  }
  return errors;
}

function parseHeaderListFromCsv(content: string): string[] {
  const firstLine =
    content.split(/\r?\n/).find((l) => l.trim().length > 0) || "";
  return parseCsvLine(firstLine).map((h) => h.trim().toLowerCase());
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

function createTemplateCsv(
  customFields: PatientRegistrationForm.Field[],
): string {
  const customColumns = customFields.map((f) => f.column);
  const allHeaders = [...SUPPORTED_BASE_HEADERS, ...customColumns];
  const sampleCustomValues = customFields.map(() => "");
  const sample = [
    "Amina",
    "Khan",
    "2012-09-15",
    "female",
    "Syria",
    "Azraq",
    "0790000000",
    "School Camp 2026",
    "GOV-1001",
    "EXT-1001",
    ...sampleCustomValues,
  ].join(",");
  return `${allHeaders.join(",")}\n${sample}\n`;
}

async function createTemplateXlsxBlob(
  customFields: PatientRegistrationForm.Field[],
): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("patients_import_template");
  const customColumns = customFields.map((f) => f.column);
  const allHeaders = [...SUPPORTED_BASE_HEADERS, ...customColumns];
  sheet.addRow(allHeaders);
  sheet.addRow([
    "Amina",
    "Khan",
    "2012-09-15",
    "female",
    "Syria",
    "Azraq",
    "0790000000",
    "School Camp 2026",
    "GOV-1001",
    "EXT-1001",
    ...customFields.map(() => ""),
  ]);
  sheet.getRow(1).font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function preValidateRows(rows: CsvRow[]): PreValidation {
  const errors: Array<{ row: number; message: string }> = [];
  const warnings: string[] = [];
  const externalSeen = new Map<string, number>();
  const governmentSeen = new Map<string, number>();

  for (const row of rows) {
    const rowNumber = row._source_row ?? -1;
    const external = (row.external_patient_id || "").trim();
    const gov = (row.government_id || "").trim();
    const dob = (row.date_of_birth || "").trim();

    if (dob && !STRICT_DATE_REGEX.test(dob)) {
      errors.push({
        row: rowNumber,
        message: "Invalid date_of_birth format. Use strict YYYY-MM-DD.",
      });
    }

    if (external) {
      const first = externalSeen.get(external);
      if (first) {
        errors.push({
          row: rowNumber,
          message: `Duplicate external_patient_id "${external}" (also at row ${first}).`,
        });
      } else {
        externalSeen.set(external, rowNumber);
      }
    }

    if (gov) {
      const first = governmentSeen.get(gov);
      if (first) {
        errors.push({
          row: rowNumber,
          message: `Duplicate government_id "${gov}" (also at row ${first}).`,
        });
      } else {
        governmentSeen.set(gov, rowNumber);
      }
    }
  }

  if (rows.length > 3000) {
    warnings.push(
      "Large file detected. Validate first and import during off-peak hours.",
    );
  }

  return { errors, warnings };
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
  const { clinics, forms } = Route.useLoaderData();

  const [selectedClinicId, setSelectedClinicId] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [lastResult, setLastResult] = useState<ImportResult | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [fileHeaderErrors, setFileHeaderErrors] = useState<string[]>([]);
  const [preValidation, setPreValidation] = useState<PreValidation>({
    errors: [],
    warnings: [],
  });

  // Derive the active custom fields for the selected clinic.
  const customFields = useMemo(
    () => getCustomFieldsForClinic(selectedClinicId || null, forms),
    [selectedClinicId, forms],
  );

  // Re-map raw rows → typed CsvRows whenever the clinic (and thus custom fields) changes.
  const rows = useMemo(
    () => rawRows.map((r) => buildCsvRow(r, customFields)),
    [rawRows, customFields],
  );

  const preview = useMemo(() => rows.slice(0, 8), [rows]);
  const hasRows = rows.length > 0;
  const hasClinic = selectedClinicId.length > 0;

  const onClinicChange = (clinicId: string) => {
    setSelectedClinicId(clinicId);
    // Clear any loaded file when the clinic changes so mappings stay consistent.
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

    const customFieldColumns = customFields.map((f) => f.column);
    const headerErrors = validateHeaders(headers, customFieldColumns);
    setFileHeaderErrors(headerErrors);

    const mapped = raw.map((r) => buildCsvRow(r, customFields));
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

  const downloadTemplateCsv = () => {
    const content = createTemplateCsv(customFields);
    downloadBlob(
      new Blob([content], { type: "text/csv;charset=utf-8;" }),
      "patient-import-template.csv",
    );
  };

  const downloadTemplateXlsx = async () => {
    const blob = await createTemplateXlsxBlob(customFields);
    downloadBlob(blob, "patient-import-template.xlsx");
  };

  const runImport = async () => {
    if (!hasRows || !hasClinic || isImporting) return;
    setIsImporting(true);
    setLastResult(null);

    try {
      const chunkSize = 500;
      let aggregate: ImportResult = {
        success: 0,
        created: 0,
        updated: 0,
        failed: 0,
        errors: [],
      };

      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const res = await importPatientsChunk({
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
      "patient-import-errors.csv",
    );
  };

  const selectedClinicName =
    clinics.find((c) => c.id === selectedClinicId)?.name ?? "";

  return (
    <div className="space-y-6 py-4">
      <div>
        <h1 className="text-2xl font-semibold">Bulk Import Patients</h1>
        <p className="text-muted-foreground mt-2">
          Upload CSV or XLSX to pre-register patients before camp day.
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
          {hasClinic && customFields.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {customFields.length} custom field
              {customFields.length !== 1 ? "s" : ""} detected for{" "}
              <strong>{selectedClinicName}</strong>:{" "}
              {customFields.map((f) => f.column).join(", ")}
            </p>
          )}
          {hasClinic && customFields.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No custom fields found for <strong>{selectedClinicName}</strong>.
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Required headers info ── */}
      <Alert>
        <AlertTitle>Required file headers</AlertTitle>
        <AlertDescription>
          <span>
            Base columns:{" "}
            <code>{SUPPORTED_BASE_HEADERS.join(", ")}</code>.
          </span>
          {customFields.length > 0 && (
            <span>
              {" "}
              Custom columns for {selectedClinicName}:{" "}
              <code>{customFields.map((f) => f.column).join(", ")}</code>.
            </span>
          )}
          {" "}At least one of <code>given_name</code> or{" "}
          <code>surname</code> is required per row.
        </AlertDescription>
      </Alert>

      {/* ── Templates ── */}
      <Card>
        <CardHeader>
          <CardTitle>
            Templates
            {hasClinic && customFields.length > 0 && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                — includes custom fields for {selectedClinicName}
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={downloadTemplateCsv}
          >
            Download CSV Template
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={downloadTemplateXlsx}
          >
            Download XLSX Template
          </Button>
        </CardContent>
      </Card>

      {/* ── Step 2: Upload file ── */}
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
                : "Import Patients"}
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

      {/* ── Preview table ── */}
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
                    <th className="text-left py-2 pr-4">Given Name</th>
                    <th className="text-left py-2 pr-4">Surname</th>
                    <th className="text-left py-2 pr-4">DOB</th>
                    <th className="text-left py-2 pr-4">External ID</th>
                    <th className="text-left py-2 pr-4">Gov ID</th>
                    {customFields.map((f) => (
                      <th key={f.id} className="text-left py-2 pr-4">
                        {f.column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr
                      key={`${r.external_patient_id || ""}-${i}`}
                      className="border-b"
                    >
                      <td className="py-2 pr-4">{r.given_name || "-"}</td>
                      <td className="py-2 pr-4">{r.surname || "-"}</td>
                      <td className="py-2 pr-4">{r.date_of_birth || "-"}</td>
                      <td className="py-2 pr-4">
                        {r.external_patient_id || "-"}
                      </td>
                      <td className="py-2 pr-4">{r.government_id || "-"}</td>
                      {customFields.map((f) => {
                        const attr = r.additional_attributes?.find(
                          (a) => a.attribute_id === f.id,
                        );
                        const val =
                          attr?.string_value ??
                          attr?.number_value?.toString() ??
                          (attr?.boolean_value !== undefined
                            ? String(attr.boolean_value)
                            : undefined) ??
                          attr?.date_value ??
                          "-";
                        return (
                          <td key={f.id} className="py-2 pr-4">
                            {val}
                          </td>
                        );
                      })}
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
