import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

/** One tunnel a test proxy was asked for. */
interface Tunnel {
  readonly target: string;
  readonly authorization: string | undefined;
}

/**
 * A proxy of the person's own, for tests: it notes each tunnel it is asked for, then opens it. `routes` sends a name that resolves nowhere to a local port, so a
 * request that skipped the proxy cannot arrive. `answer` makes it refuse with that status.
 */
export const makeProxy = async (
  options: { readonly credentials?: string; readonly answer?: number } = {},
) => {
  const tunnels: Array<Tunnel> = [];
  const routes = new Map<string, number>();
  const sockets = new Set<NodeNet.Socket>();
  let open = 0;
  let idle: Array<() => void> = [];
  const proxy = NodeHttp.createServer();
  proxy.on("connect", (request, client: NodeNet.Socket) => {
    const tunnel: Tunnel = {
      target: request.url ?? "",
      authorization: request.headers["proxy-authorization"],
    };
    tunnels.push(tunnel);
    if (options.answer !== undefined) {
      client.end(`HTTP/1.1 ${options.answer} Refused\r\ncontent-length: 0\r\n\r\n`);
      return;
    }
    const [host = "", port = "443"] = tunnel.target.split(":");
    const routed = routes.get(tunnel.target);
    const target = NodeNet.connect(
      routed ?? Number(port),
      routed === undefined ? host : "127.0.0.1",
    );
    target.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      target.pipe(client);
      client.pipe(target);
    });
    open += 1;
    // As a real proxy does: when the far side is done the tunnel is closed, not left half open.
    target.once("close", () => client.destroy());
    client.once("close", () => {
      open -= 1;
      target.destroy();
      if (open === 0) for (const done of idle.splice(0)) done();
    });
    for (const socket of [client, target]) {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    tunnels,
    routes,
    port: address.port,
    url: new URL(`http://${options.credentials ?? "ada:secret"}@127.0.0.1:${address.port}`),
    /** Resolves once no tunnel is open: at once when none is. */
    idle: (): Promise<void> =>
      open === 0 ? Promise.resolve() : new Promise((resolve) => idle.push(resolve)),
    [Symbol.asyncDispose]: async () => {
      idle = [];
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => proxy.close(resolve));
    },
  };
};
