import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { LogStream } from "@/app/components/logs/LogStream";
import { Button } from "@/app/components/ui/Button";

export const dynamic = "force-dynamic";

export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ clusterId: string }>;
  searchParams: Promise<{ cluster?: string }>;
}) {
  const [{ clusterId }, { cluster }] = await Promise.all([params, searchParams]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Link href="/dashboard">
          <Button variant="ghost" size="sm">
            <ArrowLeft size={14} />
            Dashboard
          </Button>
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Logs</h1>
      </div>
      <LogStream clusterId={clusterId} cluster={cluster || undefined} tail={200} />
    </div>
  );
}
