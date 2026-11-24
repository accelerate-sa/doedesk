import { describe, expect, it } from "vite-plus/test";

import { Pseudonymizer } from "./pseudonymizer.ts";
import { maskRequestBody } from "./requestMasking.ts";
import { EventStreamUnmasker, unmaskDeep } from "./responseUnmasking.ts";
import { Restorations } from "./restorations.ts";
import { Vault } from "./vault.ts";

const setup = () => {
  const vault = new Vault();
  const token = vault.tokenFor("PERSON", "Thessaly Brackenridge");
  return { token, stream: new EventStreamUnmasker(vault) };
};

const gemini = (parts: ReadonlyArray<unknown>, finishReason?: string) =>
  JSON.stringify({
    response: {
      candidates: [
        { content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) },
      ],
    },
  });

const partsOf = (event: string): ReadonlyArray<Record<string, unknown>> =>
  (
    JSON.parse(event) as {
      response: { candidates: Array<{ content: { parts: Array<Record<string, unknown>> } }> };
    }
  ).response.candidates[0]?.content.parts ?? [];

describe("Gemini reply streams", () => {
  it("restores tool arguments in an event that also carries text", () => {
    const { token, stream } = setup();
    const [event = ""] = stream.transformEvent(
      gemini([
        { text: `Looking up ${token}.` },
        { functionCall: { name: "lookup", args: { client: token, notes: [`for ${token}`] } } },
      ]),
    );
    const [text, call] = partsOf(event);
    expect(text?.text).toBe("Looking up Thessaly Brackenridge.");
    expect(call?.functionCall).toEqual({
      name: "lookup",
      args: { client: "Thessaly Brackenridge", notes: ["for Thessaly Brackenridge"] },
    });
  });

  it("restores tool arguments in an event with no text", () => {
    const { token, stream } = setup();
    const [event = ""] = stream.transformEvent(
      gemini([{ functionCall: { name: "lookup", args: { client: token } } }]),
    );
    expect(partsOf(event)[0]?.functionCall).toEqual({
      name: "lookup",
      args: { client: "Thessaly Brackenridge" },
    });
  });

  it("holds a stand-in cut between two events and leaves thoughts as written", () => {
    const { token, stream } = setup();
    const first = stream.transformEvent(
      gemini([
        { thought: true, text: `thinking about ${token}` },
        { text: `Dear ${token.slice(0, 9)}` },
      ]),
    );
    const second = stream.transformEvent(gemini([{ text: `${token.slice(9)}, hello.` }], "STOP"));
    const texts = [...first, ...second].flatMap((event) => partsOf(event));
    expect(texts[0]?.text).toBe(`thinking about ${token}`);
    expect(
      texts
        .slice(1)
        .map((part) => part.text)
        .join(""),
    ).toBe("Dear Thessaly Brackenridge, hello.");
  });
});

describe("a sealed file's label in a reply", () => {
  it("is turned back into the file's name exactly, whole and in pieces, and in what a tool is run with", () => {
    const vault = new Vault();
    const person = vault.tokenFor("PERSON", "Khalid Al Otaibi");
    const label = `${person}_warning_letter.txt`;
    vault.fileLabels.from(() => [{ name: "Khalid_Al_Otaibi_warning_letter.txt", label }]);

    const reply = {
      content: [
        {
          type: "text",
          text: `${person} is named in ${label} and ${person}_warning_letter-summary.md.`,
        },
        { type: "tool_use", id: "t1", name: "Read", input: { path: `hr/${label}` } },
      ],
    };
    unmaskDeep(reply, vault);
    // In prose the value reads as the person writes it; in the name, as the file spells it.
    expect(reply.content[0]?.text).toBe(
      "Khalid Al Otaibi is named in Khalid_Al_Otaibi_warning_letter.txt and Khalid_Al_Otaibi_warning_letter-summary.md.",
    );
    expect(reply.content[1]?.input).toEqual({ path: "hr/Khalid_Al_Otaibi_warning_letter.txt" });

    // In pieces: the stand-in is complete before the text that makes it a file's name arrives.
    const stream = new EventStreamUnmasker(vault);
    const delta = (body: Record<string, unknown>) =>
      JSON.stringify({ type: "content_block_delta", index: 0, delta: body });
    const shown = [
      ...stream.transformEvent(delta({ type: "text_delta", text: `Open ${person}` })),
      ...stream.transformEvent(delta({ type: "text_delta", text: "_warning" })),
      ...stream.transformEvent(delta({ type: "text_delta", text: `_letter.txt for ${person}` })),
      ...stream.transformEvent(delta({ type: "text_delta", text: " today." })),
      ...stream.transformEvent(JSON.stringify({ type: "content_block_stop", index: 0 })),
    ]
      .map((event) => JSON.parse(event) as { delta?: { text?: string } })
      .map((event) => event.delta?.text ?? "")
      .join("");
    expect(shown).toBe("Open Khalid_Al_Otaibi_warning_letter.txt for Khalid Al Otaibi today.");
  });
});

describe("values of sealed documents in a reply", () => {
  const sealedSetup = () => {
    const vault = new Vault();
    const amount = vault.sealedTokenFor("AMOUNT", "SAR 4,812,650.40", true);
    const days = vault.sealedTokenFor("AMOUNT", "42", false);
    const person = vault.tokenFor("PERSON", "Thessaly Brackenridge");
    const restorations = new Restorations();
    return {
      vault,
      amount,
      days,
      person,
      restorations,
      stream: new EventStreamUnmasker(vault, restorations),
    };
  };
  const delta = (index: number, body: Record<string, unknown>) =>
    JSON.stringify({ type: "content_block_delta", index, delta: body });
  const text = (events: ReadonlyArray<string>) =>
    events
      .map((event) => JSON.parse(event) as { delta?: { text?: string; partial_json?: string } })
      .map((event) => event.delta?.text ?? event.delta?.partial_json ?? "")
      .join("");

  it("are restored in the text the person reads and never in what a tool is run with", () => {
    const { amount, days, person, stream } = sealedSetup();
    const shown = text([
      ...stream.transformEvent(
        delta(0, { type: "text_delta", text: `${person} owes ${amount}, ` }),
      ),
      ...stream.transformEvent(delta(0, { type: "text_delta", text: `filed ${days} days late.` })),
      ...stream.transformEvent(JSON.stringify({ type: "content_block_stop", index: 0 })),
    ]);
    expect(shown).toBe("Thessaly Brackenridge owes SAR 4,812,650.40, filed 42 days late.");
    const command = text(
      stream.transformEvent(
        delta(1, {
          type: "input_json_delta",
          partial_json: `{"command":"python3 -c 'print(\\"${amount}\\")' # ${person}"}`,
        }),
      ),
    );
    // A person's name is restored for the tool, as before; the sealed amount is not.
    expect(command).toContain("Thessaly Brackenridge");
    expect(command).toContain(amount);
    expect(command).not.toContain("4,812,650.40");
  });

  it("stay stand-ins in a tool call that arrives whole, in every format", () => {
    const { vault, amount, restorations } = sealedSetup();
    const reply = {
      content: [
        { type: "text", text: `The cap is ${amount}.` },
        { type: "tool_use", id: "t1", name: "Write", input: { path: "/w/a.txt", content: amount } },
      ],
      output: [{ type: "function_call", arguments: JSON.stringify({ note: amount }) }],
      candidates: [
        { content: { parts: [{ functionCall: { name: "save", args: { note: amount } } }] } },
      ],
    };
    unmaskDeep(reply, vault, restorations);
    expect(reply.content[0]?.text).toBe("The cap is SAR 4,812,650.40.");
    const whole =
      JSON.stringify(reply.content[1]) +
      JSON.stringify(reply.output) +
      JSON.stringify(reply.candidates);
    expect(whole).not.toContain("4,812,650.40");
    expect(whole.split(amount).length - 1).toBe(3);
  });

  it("writes a unit once when the reply puts its own beside a value that carries one", async () => {
    const { vault, amount, restorations, stream } = sealedSetup();
    // Whole, with the unit after the value in another language and before it in the same one.
    const reply = {
      content: [
        { type: "text", text: `الحد الأقصى ${amount} ريال، أي SAR ${amount}.` },
        // What a tool is run with is not text for the person: nothing sealed is restored there.
        { type: "tool_use", id: "t1", name: "Write", input: { content: `${amount} ريال` } },
      ],
    };
    unmaskDeep(reply, vault, restorations);
    expect(reply.content[0]?.text).toBe("الحد الأقصى 4,812,650.40 ريال، أي SAR 4,812,650.40.");
    expect(JSON.stringify(reply.content[1])).toContain(amount);

    // In pieces: the unit arrives after the value was already complete.
    const shown = text([
      ...stream.transformEvent(delta(0, { type: "text_delta", text: `المبلغ ${amount}` })),
      ...stream.transformEvent(delta(0, { type: "text_delta", text: " ريال سعودي. " })),
      ...stream.transformEvent(delta(0, { type: "text_delta", text: `Cap: ${amount}` })),
      ...stream.transformEvent(JSON.stringify({ type: "content_block_stop", index: 0 })),
    ]);
    // A value with no unit beside it keeps the one it carries.
    expect(shown).toBe("المبلغ 4,812,650.40 ريال سعودي. Cap: SAR 4,812,650.40");
    // The same in a Responses stream, where the closing event carries the whole text again.
    const responses = new EventStreamUnmasker(vault, restorations);
    const piece = (delta: string) =>
      JSON.stringify({
        type: "response.output_text.delta",
        item_id: "m1",
        content_index: 0,
        delta,
      });
    const events = [
      ...responses.transformEvent(piece(`Total ${amount}`)),
      ...responses.transformEvent(piece(" SAR")),
      ...responses.transformEvent(
        JSON.stringify({
          type: "response.output_text.done",
          item_id: "m1",
          content_index: 0,
          text: `Total ${amount} SAR`,
        }),
      ),
    ].map((event) => JSON.parse(event) as { delta?: string; text?: string });
    expect(events.map((event) => event.delta ?? "").join("")).toBe("Total 4,812,650.40 SAR");
    expect(events.at(-1)?.text).toBe("Total 4,812,650.40 SAR");

    // Sent again as shown, the stand-in goes back; rewritten by the client, the value written
    // without its unit is still found.
    const body = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: shown }] },
        { role: "assistant", content: [{ type: "text", text: "Summary: 4,812,650.40 riyals." }] },
      ],
    };
    const noDetector = {
      detect: (texts: ReadonlyArray<string>) => Promise.resolve(texts.map(() => [])),
    };
    await maskRequestBody(
      "anthropic-messages",
      body,
      new Pseudonymizer(vault, noDetector),
      undefined,
      {
        remask: (candidate) => restorations.masked(candidate),
      },
    );
    expect(JSON.stringify(body)).not.toContain("4,812,650.40");
    expect(body.messages[1]?.content[0]).toMatchObject({ text: `Summary: ${amount} riyals.` });
  });

  it("go back as stand-ins when the client sends the text again, short values included", async () => {
    const { vault, amount, days, restorations, stream } = sealedSetup();
    const shown = text([
      ...stream.transformEvent(
        delta(0, { type: "text_delta", text: `Filed ${days} days after; cap ${amount}.` }),
      ),
      ...stream.transformEvent(JSON.stringify({ type: "content_block_stop", index: 0 })),
    ]);
    expect(shown).toBe("Filed 42 days after; cap SAR 4,812,650.40.");
    const body = {
      messages: [
        { role: "user", content: "Why is the cap SAR 4,812,650.40?" },
        { role: "assistant", content: [{ type: "text", text: shown }] },
        // Text that is not what was shown (a client that rewrote it): the distinctive value is
        // still found and hidden; the short one cannot be told from any other 42.
        { role: "assistant", content: [{ type: "text", text: "Cap SAR 4,812,650.40, 42 days." }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t9",
              content: "grep: cap SAR 4,812,650.40 found, 42 lines",
            },
          ],
        },
      ],
    };
    const noDetector = {
      detect: (texts: ReadonlyArray<string>) => Promise.resolve(texts.map(() => [])),
    };
    const pseudonymizer = new Pseudonymizer(vault, noDetector);
    const remask = (candidate: string) => restorations.masked(candidate);
    const masked = await maskRequestBody("anthropic-messages", body, pseudonymizer, undefined, {
      remask,
    });
    // Both were replaced in this request, the short one too: the client sent the real values.
    expect(masked.stats.replaced.toSorted()).toEqual([amount, days].toSorted());
    // A later turn whose only trace of the values is the reply the person read: a client that
    // dropped the tool results still sends real values, and the turn says they were replaced.
    const later = await maskRequestBody(
      "anthropic-messages",
      {
        messages: [
          { role: "user", content: "Thanks." },
          { role: "assistant", content: [{ type: "text", text: shown }] },
          { role: "user", content: "Write that into the file." },
        ],
      },
      pseudonymizer,
      undefined,
      { remask },
    );
    expect(later.stats.replaced.toSorted()).toEqual([amount, days].toSorted());
    expect(later.stats.masked).toBe(2);
    const sent = body.messages.map((message) =>
      typeof message.content === "string"
        ? message.content
        : (message.content[0] as { text?: string; content?: string }),
    );
    // Exactly as the model wrote it: both stand-ins back, the short value included.
    expect((sent[1] as { text: string }).text).toBe(`Filed ${days} days after; cap ${amount}.`);
    expect((sent[2] as { text: string }).text).toBe(`Cap ${amount}, 42 days.`);
    // What the person typed after reading it is searched too.
    expect(sent[0]).toBe(`Why is the cap ${amount}?`);
    // What a tool returned is not: a file of guesses read back would show which one is the value.
    expect((sent[3] as { content: string }).content).toBe(
      "grep: cap SAR 4,812,650.40 found, 42 lines",
    );
  });
});
