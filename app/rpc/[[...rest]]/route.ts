import { RPCHandler } from "@orpc/server/fetch";
import { onError } from "@orpc/server";
import { router } from "@/lib/rpc/router";

// RPC handlers stream live state from the sparkrun CLI — nothing here is
// cacheable, so opt the route out of any prerender/cache attempts.
// https://nextjs.org/docs/app/guides/caching-without-cache-components#dynamic
export const dynamic = "force-dynamic";

const handler = new RPCHandler(router, {
  interceptors: [
    onError((error) => {
      console.error("[rpc]", error);
    }),
  ],
});

export function withSseDeliveryHeaders(response: Response): Response {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.startsWith("text/event-stream")) return response;

  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, no-store, no-transform");
  headers.set("x-accel-buffering", "no");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handle(request: Request): Promise<Response> {
  const { response } = await handler.handle(request, {
    prefix: "/rpc",
    context: {},
  });
  return withSseDeliveryHeaders(response ?? new Response("Not found", { status: 404 }));
}

export const HEAD = handle;
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
