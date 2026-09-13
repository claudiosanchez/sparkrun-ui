import { serverClient } from "@/lib/rpc/server";
import { ChatPage } from "@/app/components/chat/ChatPage";

export const dynamic = "force-dynamic";

export default async function ChatRoute({
  searchParams,
}: {
  searchParams: Promise<{ clusterId?: string; cluster?: string }>;
}) {
  const sp = await searchParams;
  const cluster = sp.cluster || undefined;
  const initial = await serverClient.status.get({ cluster });
  return (
    <ChatPage
      key={JSON.stringify([cluster, sp.clusterId])}
      initial={initial}
      initialClusterId={sp.clusterId}
      cluster={cluster}
    />
  );
}
