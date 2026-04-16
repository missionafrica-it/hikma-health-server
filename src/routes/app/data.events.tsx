import { createFileRoute } from "@tanstack/react-router";
import { getEventForms } from "@/lib/server-functions/event-forms";
import { SelectInput } from "@/components/select-input";
import { Fragment, useEffect, useState } from "react";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  getEventsByFormId,
  getAllEventsWithPatientsForExport,
  type EventWithPatient,
} from "@/lib/server-functions/events";
import EventForm from "@/models/event-form";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/app/data/events")({
  component: RouteComponent,
  loader: async () => {
    return {
      forms: await getEventForms({ data: { includeDeleted: true } }),
    };
  },
});

// ── CSV export helper ───────────────────────────────────────

function exportToCsv(
  filename: string,
  rows: EventWithPatient[],
  formFields: readonly EventForm.Field[],
) {
  const patientHeaders = [
    "Patient ID",
    "Given Name",
    "Surname",
    "Date of Birth",
    "Sex",
  ];
  const formHeaders = formFields.map((f) => f.name);
  const headers = ["Date", ...patientHeaders, ...formHeaders];

  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };

  const lines = [
    headers.map(escape).join(","),
    ...rows.map((event) => {
      const date = format(new Date(event.created_at), "yyyy-MM-dd HH:mm:ss");
      const patientCols = [
        event.patient_external_id ?? event.patient_id,
        event.patient_given_name ?? "",
        event.patient_surname ?? "",
        event.patient_date_of_birth ?? "",
        event.patient_sex ?? "",
      ];
      const formCols = formFields.map((col) => {
        const field = event.form_data.find((c) => c.fieldId === col.id);
        if (!field) return "";
        if (col.fieldType === "diagnosis") {
          return (field.value as Array<{ code: string; desc: string }>)
            ?.map((d) => `(${d.code}) ${d.desc}`)
            .join("; ");
        }
        if (col.fieldType === "medicine") {
          return (
            field.value as Array<{ name: string; dose: number; doseUnits: string }>
          )
            ?.map((m) => `${m.name} ${m.dose}${m.doseUnits}`)
            .join("; ");
        }
        return field.value ?? "";
      });
      return [date, ...patientCols, ...formCols].map(escape).join(",");
    }),
  ];

  const blob = new Blob([lines.join("\n")], {
    type: "text/csv;charset=utf-8;",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Route component ─────────────────────────────────────────

function RouteComponent() {
  const { forms } = Route.useLoaderData();

  const [eventsList, setEventsList] = useState<EventWithPatient[]>([]);
  const [paginationResults, setPaginationResults] = useState<{
    pagination: {
      total: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    };
  }>({
    pagination: { total: 0, offset: 0, limit: 50, hasMore: false },
  });

  const [selectedForm, setSelectedForm] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const pageSize = paginationResults.pagination.limit || 50;
  const totalItems = paginationResults.pagination.total;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  const fetchEvents = (page = 1) => {
    if (!selectedForm) return;
    setLoading(true);
    const offset = (page - 1) * pageSize;

    getEventsByFormId({ data: { form_id: selectedForm, offset, limit: pageSize } })
      .then((res) => {
        setEventsList(res.events);
        setPaginationResults(res);
        setCurrentPage(page);
      })
      .catch(() => toast.error("Failed to load events"))
      .finally(() => setLoading(false));
  };

  const handleExport = async () => {
    if (!selectedForm) return;
    setExporting(true);
    try {
      const { events } = await getAllEventsWithPatientsForExport({
        data: { form_id: selectedForm },
      });
      const formName =
        forms.find((f) => f.id === selectedForm)?.name ?? "events";
      exportToCsv(`${formName}.csv`, events, tableColumns);
      toast.success(`Exported ${events.length} rows`);
    } catch {
      toast.error("Export failed");
    } finally {
      setExporting(false);
    }
  };

  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages && page !== currentPage) {
      fetchEvents(page);
    }
  };

  useEffect(() => {
    if (selectedForm) fetchEvents();
  }, [selectedForm]);

  const getPageNumbers = () => {
    const firstPage = 1;
    const lastPage = totalPages;
    const nearbyPages = Array.from(
      { length: 3 },
      (_, i) => Math.max(2, currentPage - 1) + i,
    ).filter((p) => p > firstPage && p < lastPage);
    return Array.from(new Set([firstPage, ...nearbyPages, lastPage])).sort(
      (a, b) => a - b,
    );
  };

  const pageNumbers = getPageNumbers();
  const tableColumns =
    forms.find((form) => form.id === selectedForm)?.form_fields ?? [];

  return (
    <div className="container py-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Events Explorer</h1>
        {selectedForm && (
          <Button
            variant="outline"
            onClick={handleExport}
            disabled={exporting || totalItems === 0}
          >
            <Download className="h-4 w-4 mr-2" />
            {exporting ? "Exporting..." : `Export CSV (${totalItems})`}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <SelectInput
          label="Select an event form"
          className="w-full"
          defaultValue={selectedForm ?? undefined}
          onChange={(value) => setSelectedForm(value)}
          labelClassName="text-[14px] font-semibold"
          data={[
            {
              label: "Active Forms",
              options: forms
                .filter((f) => !f.is_deleted)
                .map((f) => ({ label: f.name, value: f.id })),
            },
            {
              label: "Deleted Forms",
              options: forms
                .filter((f) => f.is_deleted)
                .map((f) => ({ label: f.name, value: f.id })),
            },
          ]}
        />
      </div>

      {!selectedForm ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Select a form above to view its data.
        </p>
      ) : loading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Loading...
        </p>
      ) : (
        <>
          <div className="rounded-md border overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableCaption>
                  {totalItems} total records
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">Date</TableHead>
                    <TableHead className="whitespace-nowrap">Patient ID</TableHead>
                    <TableHead className="whitespace-nowrap">Given Name</TableHead>
                    <TableHead className="whitespace-nowrap">Surname</TableHead>
                    <TableHead className="whitespace-nowrap">DOB</TableHead>
                    <TableHead className="whitespace-nowrap">Sex</TableHead>
                    {tableColumns.map((col) => (
                      <TableHead key={col.id} className="whitespace-nowrap">
                        {col.name}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {eventsList.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={6 + tableColumns.length}
                        className="text-center text-muted-foreground py-8"
                      >
                        No records found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    eventsList.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                          {format(new Date(event.created_at), "yyyy-MM-dd HH:mm")}
                        </TableCell>
                        <TableCell className="text-xs font-mono">
                          {event.patient_external_id || event.patient_id.slice(0, 8) + "…"}
                        </TableCell>
                        <TableCell>{event.patient_given_name ?? "—"}</TableCell>
                        <TableCell>{event.patient_surname ?? "—"}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {event.patient_date_of_birth ?? "—"}
                        </TableCell>
                        <TableCell>{event.patient_sex ?? "—"}</TableCell>
                        {tableColumns.map((col) => {
                          const field = event.form_data.find(
                            (c) => c.fieldId === col.id,
                          );
                          if (col.fieldType === "diagnosis") {
                            return (
                              <TableCell key={col.id}>
                                <RenderDiagnosisField field={field as any} />
                              </TableCell>
                            );
                          }
                          if (col.fieldType === "medicine") {
                            return (
                              <TableCell key={col.id}>
                                <RenderMedicineField field={field as any} />
                              </TableCell>
                            );
                          }
                          return (
                            <TableCell key={col.id}>{field?.value ?? "—"}</TableCell>
                          );
                        })}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </div>

          <div className="py-8">
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => handlePageChange(currentPage - 1)}
                    className={
                      currentPage <= 1
                        ? "pointer-events-none opacity-50"
                        : "cursor-pointer"
                    }
                  />
                </PaginationItem>

                {pageNumbers.map((pageNumber, index) => {
                  const showEllipsis =
                    index > 0 && pageNumber > pageNumbers[index - 1] + 1;
                  return (
                    <Fragment key={`page-${pageNumber}`}>
                      {showEllipsis && (
                        <PaginationItem>
                          <PaginationEllipsis />
                        </PaginationItem>
                      )}
                      <PaginationItem>
                        <PaginationLink
                          onClick={() => handlePageChange(pageNumber)}
                          isActive={pageNumber === currentPage}
                          className="cursor-pointer"
                        >
                          {pageNumber}
                        </PaginationLink>
                      </PaginationItem>
                    </Fragment>
                  );
                })}

                <PaginationItem>
                  <PaginationNext
                    onClick={() => handlePageChange(currentPage + 1)}
                    className={
                      currentPage >= totalPages
                        ? "pointer-events-none opacity-50"
                        : "cursor-pointer"
                    }
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        </>
      )}
    </div>
  );
}

function RenderDiagnosisField({
  field,
}: {
  field?: { value: Array<{ code: string; desc: string }> };
}) {
  return (
    <div>
      {field?.value
        ?.map((d) => `(${d.code}) ${d.desc}`)
        .join(", ")}
    </div>
  );
}

function RenderMedicineField({
  field,
}: {
  field?: {
    value: Array<{
      dose: number;
      doseUnits: string;
      form: string;
      frequency: string;
      name: string;
      route: string;
    }>;
  };
}) {
  return (
    <div className="space-y-1">
      {field?.value?.map((m, i) => (
        <div key={i} className="text-xs">
          <span className="font-medium">{m.name}</span>{" "}
          ({m.dose} {m.doseUnits}) — {m.form}, {m.route}, {m.frequency}
        </div>
      ))}
    </div>
  );
}
