// A minimal MCP server over stdio for the conformance run. Its one tool returns planted values.
import * as NodeReadline from "node:readline";

const text = process.env.PLANTED_TEXT ?? "";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: request.id, result });
  if (request.method === "initialize") {
    reply({
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "planted", version: "1.0.0" },
    });
  } else if (request.method === "tools/list") {
    reply({
      tools: [
        {
          name: "lookup_client",
          description: "Returns the record the office keeps for the current client.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  } else if (request.method === "tools/call") {
    reply({ content: [{ type: "text", text }] });
  } else {
    reply({});
  }
});
