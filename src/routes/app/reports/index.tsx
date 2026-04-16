import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import Report from "@/models/report";
import ServerVariable from "@/models/server_variable";
import { superAdminMiddleware } from "@/middleware/auth";
import { truncate } from "es-toolkit/compat";
import { AlertTriangleIcon, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useState } from "react";
import { toast } from "sonner";

const getAllReports = createServerFn({ method: "GET" })
  .middleware([superAdminMiddleware])
  .handler(async () => {
    return await Report.API.getAll();
  });

const deleteReport = createServerFn({ method: "POST" })
  .inputValidator((data: { id: string }) => data)
  .middleware([superAdminMiddleware])
  .handler(async ({ data }) => {
    await Report.API.softDelete(data.id);
  });

const checkAiConfig = createServerFn({ method: "GET" })
  .middleware([superAdminMiddleware])
  .handler(async () => {
    const anthropicKey = await ServerVariable.getAsString(
      ServerVariable.Keys.ANTHROPIC_API_KEY,
    );
    return { hasAnthropicKey: !!anthropicKey };
  });

export const Route = createFileRoute("/app/reports/")({
  component: RouteComponent,
  loader: async ({ context: { aiConfig, reports } }) => {
    return { reports, aiConfig };
  },
  beforeLoad: async () => {
    const [reports, aiConfig] = await Promise.all([
      getAllReports(),
      checkAiConfig().catch(() => ({ hasAnthropicKey: false })),
    ]);
    return { reports, aiConfig };
  },
});

function RouteComponent() {
  const { reports: initialReports, aiConfig } = Route.useLoaderData();
  const navigate = useNavigate();
  const aiConfigured = aiConfig.hasAnthropicKey;
  const [reports, setReports] = useState(initialReports);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const handleDelete = async (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    if (!window.confirm(`Delete report "${name}"? This cannot be undone.`)) return;
    setDeletingId(id);
    try {
      await deleteReport({ data: { id } });
      setReports((prev) => prev.filter((r) => r.id !== id));
      toast.success("Report deleted");
    } catch {
      toast.error("Failed to delete report");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Reports</h1>
        <Link to="/app/reports/$id/edit" params={{ id: "new" }}>
          <Button disabled={!aiConfigured}>Create Report</Button>
        </Link>
      </div>

      <Alert className=" border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-50">
        <AlertTriangleIcon />
        <AlertTitle>🧪 Reports feature is under development.</AlertTitle>
        <AlertDescription>
          The reports feature is new and under active development. Please report
          any issues you experience and expect changes in the coming weeks.
        </AlertDescription>
      </Alert>

      {!aiConfigured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 space-y-1">
          <p className="font-medium">AI not configured</p>
          <p>
            To generate reports with AI, set your Anthropic API key in the{" "}
            <Link
              to="/app/settings/configurations"
              className="underline font-medium"
            >
              configurations page
            </Link>
            .
          </p>
        </div>
      )}

      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
        <p className="font-medium">🚩 Verify AI-generated reports</p>
        <p>
          AI-generated reports may contain inaccuracies. Always review the
          underlying data and queries before making decisions based on these
          results.
        </p>
      </div>

      {reports.length === 0 ? (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-6 text-sm text-zinc-600">
          <p>No reports yet. Create one to get started.</p>
        </div>
      ) : (
        <div className="rounded-md border overflow-hidden">
          <Table className="overflow-scroll">
            <TableHeader>
              <TableRow>
                <TableHead className="px-6">Name</TableHead>
                <TableHead className="px-6">Description</TableHead>
                <TableHead className="px-6">Updated</TableHead>
                <TableHead className="px-6 w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow
                  key={report.id}
                  className="hover:bg-gray-100 cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/app/reports/$id",
                      params: { id: report.id },
                    })
                  }
                >
                  <TableCell className="px-6">{report.name}</TableCell>
                  <TableCell className="px-6 text-zinc-500 whitespace-pre">
                    {truncate(report.description || "—", { length: 256 })}
                  </TableCell>
                  <TableCell className="px-6 text-zinc-500">
                    {new Date(report.updated_at)?.toLocaleDateString()}
                  </TableCell>
                  <TableCell className="px-6">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-50"
                      disabled={deletingId === report.id}
                      onClick={(e) => handleDelete(e, report.id, report.name)}
                      title="Delete report"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
