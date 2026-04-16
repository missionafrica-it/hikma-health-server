import { createServerFn } from "@tanstack/react-start";
import Anthropic from "@anthropic-ai/sdk";
import User from "@/models/user";
import {
  constructLayoutConfig,
  constructReport,
  type report as Report,
  type reportComponent,
  type componentDisplay,
  type timeRange,
} from "./report.gen";
import PatientRegistrationForm from "@/models/patient-registration-form";
import EventForm from "@/models/event-form";
import PatientVital from "@/models/patient-vital";
import PatientProblem from "@/models/patient-problem";
import Patient from "@/models/patient";
import PatientAdditionalAttribute from "@/models/patient-additional-attribute";
import {
  isUserSuperAdmin,
  getCurrentUserId,
} from "../auth/request";
import ReportModel from "@/models/report";
import db from "@/db";
import Event from "@/models/event";
import Visit from "@/models/visit";
import Clinic from "@/models/clinic";
import { uuidv7 } from "uuidv7";
import { z } from "zod";
import { sql, type TableMetadata } from "kysely";

// ── AI Response Types (snake_case from the AI service) ─────

type AIDisplayConfig = {
  type: string;
  config: Record<string, unknown>;
};

type AIReportComponent = {
  title: string;
  description?: string;
  prql_source: string;
  compiled_sql: string;
  compile_error: string | null;
  display: AIDisplayConfig;
  position: { x: number; y: number; w: number; h: number };
};

// ── Parsing ────────────────────────────────────────────────

const parseFormat = (f: unknown) => {
  if (f === "number") return "Number" as const;
  if (f === "currency") return "Currency" as const;
  if (f === "percent") return "Percent" as const;
  return undefined;
};

const parseTableFormat = (f: unknown) => {
  const base = parseFormat(f);
  if (base) return base;
  if (f === "date") return "Date" as const;
  return undefined;
};

const parseOrientation = (o: unknown) => {
  if (o === "horizontal") return "Horizontal" as const;
  if (o === "vertical") return "Vertical" as const;
  return undefined;
};

const parseSortDir = (d: unknown) => {
  if (d === "asc") return "Asc" as const;
  if (d === "desc") return "Desc" as const;
  return undefined;
};

export const parseDisplayType = (
  display: AIDisplayConfig,
): componentDisplay | null => {
  const { type, config } = display;

  switch (type) {
    case "stat_card":
      return {
        TAG: "StatCard",
        _0: {
          valueField: config.value_field as string,
          label: config.label as string,
          ...(config.format != null && { format: parseFormat(config.format) }),
          ...(config.comparison_field != null && {
            comparisonField: config.comparison_field as string,
          }),
        },
      };

    case "table":
      return {
        TAG: "Table",
        _0: {
          columns: (config.columns as any[]).map((col) => ({
            key: col.key as string,
            label: col.label as string,
            ...(col.format != null && { format: parseTableFormat(col.format) }),
            ...(col.sortable != null && { sortable: col.sortable as boolean }),
          })),
        },
      };

    case "line_chart":
      return {
        TAG: "LineChart",
        _0: {
          xAxis: config.x_axis as string,
          yAxis: config.y_axis as string,
          ...(config.series_field != null && {
            seriesField: config.series_field as string,
          }),
        },
      };

    case "pie_chart":
      return {
        TAG: "PieChart",
        _0: {
          labelField: config.label_field as string,
          valueField: config.value_field as string,
        },
      };

    case "bar_chart":
      return {
        TAG: "BarChart",
        _0: {
          xAxis: config.x_axis as string,
          yAxis: config.y_axis as string,
          ...(config.orientation != null && {
            orientation: parseOrientation(config.orientation),
          }),
          ...(config.stacked != null && { stacked: config.stacked as boolean }),
          ...(config.sort_by != null && { sortBy: config.sort_by as string }),
          ...(config.sort_dir != null && {
            sortDir: parseSortDir(config.sort_dir),
          }),
        },
      };

    default:
      return null;
  }
};

export const parseAIReportComponent = (
  raw: AIReportComponent,
  reportId: string,
): reportComponent | null => {
  if (raw.compile_error) return null;

  const display = parseDisplayType(raw.display);
  if (!display) return null;

  return {
    id: uuidv7(),
    reportId,
    title: raw.title,
    ...(raw.description != null && { description: raw.description }),
    prqlSource: raw.prql_source,
    compiledSql: raw.compiled_sql,
    compiledAt: new Date().toISOString(),
    compilerVersion: "0.1.0",
    position: raw.position,
    display,
  };
};

export const parseAIResponse = (
  components: AIReportComponent[],
  reportId: string,
): reportComponent[] =>
  components.reduce<reportComponent[]>((acc, raw) => {
    const parsed = parseAIReportComponent(raw, reportId);
    return parsed ? [...acc, parsed] : acc;
  }, []);

// ── SQL Execution ──────────────────────────────────────────

// Patterns that should never appear in compiled SQL.
const DANGEROUS_SQL_PATTERNS = [
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE)\b/i,
  /\b(GRANT|REVOKE|COMMIT|ROLLBACK|SAVEPOINT)\b/i,
  /\b(EXEC|EXECUTE|CALL)\b/i,
  /\b(ATTACH|DETACH)\b/i,
  /\b(PRAGMA)\b/i,
  /\b(VACUUM|REINDEX|ANALYZE)\b/i,
  /;\s*\S/, // multiple statements
];

export type ComponentData = {
  componentId: string;
  rows: Record<string, unknown>[];
  error: string | null;
};

const validateCompiledSql = (compiledSql: string): void => {
  for (const pattern of DANGEROUS_SQL_PATTERNS) {
    if (pattern.test(compiledSql)) {
      throw new Error(
        `Compiled SQL rejected: matches forbidden pattern ${pattern}`,
      );
    }
  }
};

const executeComponentQuery = async (
  compiledSql: string,
  startAt: string,
  endAt: string,
): Promise<Record<string, unknown>[]> => {
  validateCompiledSql(compiledSql);

  const rows = await db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    // Replace $1/$2 placeholders with Kysely-managed parameter bindings
    const parts = compiledSql.split(/\$[12]/);
    const params = [startAt, endAt];
    const bound = parts.reduce<ReturnType<typeof sql<Record<string, unknown>>>>(
      (acc, part, i) => {
        if (i === 0) return sql<Record<string, unknown>>`${sql.raw(part)}`;
        return sql<
          Record<string, unknown>
        >`${acc}${params[i - 1]}${sql.raw(part)}`;
      },
      sql``,
    );
    const result = await bound.execute(trx);
    return result.rows;
  });
  return rows;
};

const fetchAllComponentDataInternal = async (
  components: reportComponent[],
  startAt: string,
  endAt: string,
): Promise<ComponentData[]> =>
  Promise.all(
    components.map(async (c) => {
      try {
        const rows = await executeComponentQuery(c.compiledSql, startAt, endAt);
        return { componentId: c.id, rows, error: null };
      } catch (err: any) {
        console.error("[Report] Error fetching component of report: ", err);
        return {
          componentId: c.id,
          rows: [],
          error: err?.message ?? "Query failed",
        };
      }
    }),
  );

export const fetchAllComponentData = createServerFn({ method: "POST" })
  .inputValidator(
    (data: { components: reportComponent[]; startAt: string; endAt: string }) =>
      data,
  )
  .handler(async ({ data }): Promise<ComponentData[]> => {
    return fetchAllComponentDataInternal(
      data.components,
      data.startAt,
      data.endAt,
    );
  });

export type ReportWithData = {
  report: Report;
  data: ComponentData[];
};

// TABLE DATA TO INCLUDE IN REPORTING
const INCLUDED_TABLES = [
  PatientAdditionalAttribute.Table.name,
  Patient.Table.name,
  PatientVital.Table.name,
  PatientProblem.Table.name,
  PatientRegistrationForm.Table.name,
  Event.Table.name,
  Visit.Table.name,
  User.Table.name,
  Clinic.Table.name,
];

import ServerVariable from "@/models/server_variable";
import { Result } from "../result";

// ── Shared input type for report endpoints ──────────────────

export type ReportInput = {
  report_id?: string;
  user_description: string;
  name: string;
  description?: string;
  time_range: timeRange;
};

export type component_request = {
  user_prompt: string;
  report_id?: string;
  name: string;
  description?: string;
  time_range: timeRange;
  /** When present, the LLM edits this component. When absent, it creates from scratch. */
  component?: {
    title: string;
    description: string;
    prql_source: string;
    display: any;
    position: any;
  };
};

// ── Prompt refinement response schema ──────────────────────

const prompt_suggestion_schema = z.object({
  refined_prompt: z.string(),
  reasoning: z.string(),
});

export const prompt_refine_response_schema = z.object({
  suggestions: z.array(prompt_suggestion_schema).length(3),
});

// ── Claude helpers ──────────────────────────────────────────

const buildSchemaContext = (
  tables: TableMetadata[],
  patient_registration_forms: any[],
  event_forms: any[],
) => {
  const schemaText = tables
    .map((t) => {
      const cols = t.columns
        .map((c) => `  ${c.name} ${c.dataType}${c.isNullable ? "" : " NOT NULL"}`)
        .join("\n");
      return `Table: ${t.name}\n${cols}`;
    })
    .join("\n\n");

  return `## Database Schema
${schemaText}

## Patient Registration Form Structure
${JSON.stringify(patient_registration_forms[0] ?? {}, null, 2)}

## Event Forms
${JSON.stringify(event_forms, null, 2)}`;
};

const COMPONENT_JSON_SCHEMA = `
Each component must have this exact JSON shape:
{
  "title": "string",
  "description": "string (optional)",
  "prql_source": "string — human-readable description of the query",
  "compiled_sql": "string — valid PostgreSQL SELECT query",
  "compile_error": null,
  "display": {
    "type": "stat_card" | "table" | "bar_chart" | "line_chart" | "pie_chart",
    "config": { ... display-specific fields below ... }
  },
  "position": { "x": number, "y": number, "w": number, "h": number }
}

Display config shapes:
- stat_card:   { "value_field": "col", "label": "text", "format": "number"|"currency"|"percent" (optional), "comparison_field": "col" (optional) }
- table:       { "columns": [{ "key": "col", "label": "text", "format": "number"|"currency"|"percent"|"date" (optional), "sortable": bool (optional) }] }
- bar_chart:   { "x_axis": "col", "y_axis": "col", "orientation": "horizontal"|"vertical" (optional), "stacked": bool (optional), "sort_by": "col" (optional), "sort_dir": "asc"|"desc" (optional) }
- line_chart:  { "x_axis": "col", "y_axis": "col", "series_field": "col" (optional) }
- pie_chart:   { "label_field": "col", "value_field": "col" }

SQL rules:
- Pure SELECT only — no INSERT/UPDATE/DELETE/DROP/CREATE/ALTER
- Date filtering: ALWAYS use $1::timestamptz for start date and $2::timestamptz for end date. Example: WHERE created_at >= $1::timestamptz AND created_at <= $2::timestamptz
- NEVER compare a timestamp column directly to an INTERVAL. This is wrong: "created_at < INTERVAL '30 days'". This is correct: "created_at >= NOW() - INTERVAL '30 days'"
- NEVER write expressions like "col < INTERVAL '...'" or "col > INTERVAL '...'". Intervals are durations, not timestamps.
- If the user's request doesn't need date filtering, omit $1/$2 entirely — do not use them as dummy values
- Column aliases must exactly match the field names referenced in the display config
- Return only columns needed by the display config
- Grid: x/y/w/h in columns (max width 12). Use h=2 for stat_card, h=4 for charts/tables. Fill the grid left-to-right.`;

async function callClaudeForComponents(
  anthropicApiKey: string,
  systemPrompt: string,
  userMessage: string,
): Promise<AIReportComponent[]> {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  const raw = jsonMatch ? jsonMatch[1] ?? jsonMatch[0] : text;
  const parsed = JSON.parse(raw.trim());
  return Array.isArray(parsed) ? parsed : (parsed.components ?? []);
}

async function callClaudeForPromptRefine(
  anthropicApiKey: string,
  systemPrompt: string,
  userMessage: string,
): Promise<z.infer<typeof prompt_refine_response_schema>> {
  const client = new Anthropic({ apiKey: anthropicApiKey });

  const message = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
  const raw = jsonMatch ? jsonMatch[1] ?? jsonMatch[0] : text;
  const parsed = JSON.parse(raw.trim());
  return prompt_refine_response_schema.parse(parsed);
}

// ── Server functions ────────────────────────────────────────

export const refineReportPrompt = createServerFn({ method: "POST" })
  .inputValidator((data: ReportInput) => data)
  .handler(
    async ({
      data,
    }): Promise<z.infer<typeof prompt_refine_response_schema>> => {
      const authorized = await isUserSuperAdmin();
      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "refineReportPrompt",
        });
      }

      const dbInfo = await getAIReportingInfo();
      if (Result.isErr(dbInfo)) {
        return Promise.reject(dbInfo.error);
      }

      const { event_forms, patient_registration_forms, tables, anthropicApiKey } = dbInfo.data;

      if (!anthropicApiKey) {
        return Promise.reject({
          message: "Anthropic API key is not configured",
          source: "refineReportPrompt",
        });
      }

      const schemaContext = buildSchemaContext(tables, patient_registration_forms, event_forms);

      const systemPrompt = `You are a health data analyst assistant. Your job is to refine natural-language report prompts so they are specific, actionable, and answerable from the available database schema.

${schemaContext}

Return ONLY a JSON object (no markdown except for the json block) matching this schema:
{
  "suggestions": [
    { "refined_prompt": "...", "reasoning": "..." },
    { "refined_prompt": "...", "reasoning": "..." },
    { "refined_prompt": "...", "reasoning": "..." }
  ]
}

Each suggestion should be a distinct, improved version of the user's prompt. Make them specific, use actual table/column names where helpful, and explain why each refinement improves the original.`;

      const userMessage = `Report name: ${data.name}
User prompt: ${data.user_description}`;

      return callClaudeForPromptRefine(anthropicApiKey, systemPrompt, userMessage);
    },
  );

/**
 * Generate or update a report using Claude directly.
 */
export const editReport = createServerFn({ method: "POST" })
  .inputValidator((data: ReportInput) => data)
  .handler(
    async ({ data }): Promise<{ report: Report; data: ComponentData[] }> => {
      const authorized = await isUserSuperAdmin();
      if (!authorized) {
        return Promise.reject({
          message: "Unauthorized: Insufficient permissions",
          source: "editReport",
        });
      }

      const dbInfo = await getAIReportingInfo();
      if (Result.isErr(dbInfo)) {
        return Promise.reject(dbInfo.error);
      }

      const { event_forms, patient_registration_forms, tables, anthropicApiKey } = dbInfo.data;

      if (!anthropicApiKey) {
        return Promise.reject({
          message: "Anthropic API key is not configured",
          source: "editReport",
        });
      }

      const reportId = data.report_id ?? uuidv7();
      const layout = constructLayoutConfig(12);

      const schemaContext = buildSchemaContext(tables, patient_registration_forms, event_forms);

      const systemPrompt = `You are a health data analyst. Generate dashboard report components as a JSON array based on the user's prompt and the database schema below.

${schemaContext}

${COMPONENT_JSON_SCHEMA}

Return ONLY a JSON array of components inside a \`\`\`json block. No other text.`;

      const userMessage = `Report name: ${data.name}
User request: ${data.user_description}

Generate 2–5 meaningful dashboard components that answer this request. Use appropriate chart types.

CRITICAL SQL DATE RULES:
- For date filtering use: column >= $1::timestamptz AND column <= $2::timestamptz
- NEVER write: column < INTERVAL '...' or column > INTERVAL '...'
- Intervals cannot be compared to timestamps directly in PostgreSQL`;

      const aiComponents = await callClaudeForComponents(anthropicApiKey, systemPrompt, userMessage);
      const parsedComponents = parseAIResponse(aiComponents, reportId);

      const report = constructReport(
        reportId,
        data.name,
        data.description ?? "",
        data.time_range,
        layout,
        parsedComponents,
      );

      const userId = await getCurrentUserId();
      const savedReport = await ReportModel.API.update({
        report,
        clinicId: null,
        createdBy: userId,
      });

      const { startAt, endAt } = ReportModel.resolveTimeRange(data.time_range);
      const componentData = await fetchAllComponentDataInternal(parsedComponents, startAt, endAt);

      return { report: savedReport, data: componentData };
    },
  );

/**
 * Update a single report component using Claude directly.
 */
export const editReportComponent = createServerFn({ method: "POST" })
  .inputValidator(
    (data: {
      report_id: string;
      user_prompt: string;
      component: {
        title: string;
        description: string;
        prql_source: string;
        display: any;
        position: any;
      };
    }) => data,
  )
  .handler(async ({ data }): Promise<reportComponent> => {
    const authorized = await isUserSuperAdmin();
    if (!authorized) {
      return Promise.reject({
        message: "Unauthorized: Insufficient permissions",
        source: "editReportComponent",
      });
    }

    const dbInfo = await getAIReportingInfo();
    if (Result.isErr(dbInfo)) {
      return Promise.reject(dbInfo.error);
    }

    const { event_forms, patient_registration_forms, tables, anthropicApiKey } = dbInfo.data;

    if (!anthropicApiKey) {
      return Promise.reject({
        message: "Anthropic API key is not configured",
        source: "editReportComponent",
      });
    }

    const schemaContext = buildSchemaContext(tables, patient_registration_forms, event_forms);

    const systemPrompt = `You are a health data analyst. Update an existing dashboard component based on the user's instruction.

${schemaContext}

${COMPONENT_JSON_SCHEMA}

Return ONLY a JSON object with a single component (not an array) inside a \`\`\`json block. Preserve the original position unless the user asks to move it.`;

    const userMessage = `Existing component:
${JSON.stringify(data.component, null, 2)}

User instruction: ${data.user_prompt}

Return the updated component JSON.`;

    const client = new Anthropic({ apiKey: anthropicApiKey });
    const message = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
    const raw = jsonMatch ? jsonMatch[1] ?? jsonMatch[0] : text;
    const rawComponent: AIReportComponent = JSON.parse(raw.trim());

    const parsed = parseAIReportComponent(rawComponent, data.report_id);
    if (!parsed) {
      return Promise.reject({
        message: "Failed to parse Claude response into a valid component",
        source: "editReportComponent",
      });
    }

    return parsed;
  });

/**
 * Loads DB schema, forms, and the Anthropic API key.
 */
const getAIReportingInfo = createServerFn().handler(async () => {
  const isAdmin = await isUserSuperAdmin();
  if (!isAdmin) {
    return Result.err({
      _tag: "Unauthorized",
      message: "Only system administrators are allowed to use this method",
    });
  }

  const patient_registration_forms = await PatientRegistrationForm.getAll();
  const event_forms = await EventForm.API.getAll();

  const tables = (
    await db.introspection.getTables({ withInternalKyselyTables: false })
  ).filter((table) => INCLUDED_TABLES.includes(table.name));

  const anthropicApiKey = await ServerVariable.getAsString(
    ServerVariable.Keys.ANTHROPIC_API_KEY,
  );

  return Result.ok({
    tables,
    patient_registration_forms,
    event_forms,
    anthropicApiKey,
  });
});
