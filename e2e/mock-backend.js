// 本地 mock。脚本名与线上 Worker 相同，但这里不是真实后端。
// /__e2e_fail 固定返回带内部地址的 500，用来确认网关不会把原文透传出去。
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const service = env.SERVICE_NAME || "unknown";
    if (url.pathname === "/__e2e_fail") {
      return new Response(JSON.stringify({
        error: "upstream_down",
        upstream: "https://" + service + ".boliam.workers.dev/internal",
        address: "10.8.0.4",
      }), {
        status: 500,
        headers: {
          "content-type": "application/json",
          "X-Backend-Host": service + ".boliam.workers.dev",
        },
      });
    }
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    return Response.json({
      ok: true,
      service,
      method: request.method,
      path: url.pathname,
      search: url.search,
      owner: request.headers.get("X-Abot-Owner-Email"),
      internalToken: request.headers.get("X-Internal-Token"),
      authorization: request.headers.get("Authorization"),
      body,
    });
  },
};
