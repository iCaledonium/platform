// The test-case designer assistant.
//
// A CONVERSATION, not a generator. Designing an assertion means reading the
// real schema, trying the query, seeing what it returns today, and being told
// "no, I meant this" — none of which a single completion does. So it holds a
// thread and it has tools.
//
// Its tools run through the SAME read-only connection the finished test case
// will use (`readQuery` in lab-cases.js). That is the whole safety story and
// also the whole point: what it demonstrates in the chat is exactly what the
// case will do, and it can write no more than the case can. It is not a
// watcher — it diagnoses nothing and watches nothing; it helps you write one
// assertion and then it is done.

import * as cases from "./lab-cases.js";

const MODEL = "claude-sonnet-5";        // a reasoning task over a real schema
const MAX_TURNS = 8;                     // tool round-trips before we stop

const TOOLS = [
  {
    name: "list_schema",
    description: "List every table in the platform database with its column names.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "run_query",
    description:
      "Run a read-only SELECT against the platform database and see the rows (max 20). " +
      "Use this to check that a query you are proposing actually works and to see what it " +
      "returns right now. Anything that writes is refused by SQLite itself.",
    input_schema: {
      type: "object",
      properties: { sql: { type: "string", description: "a single SELECT statement" } },
      required: ["sql"],
    },
  },
  {
    name: "propose_test_case",
    description:
      "Propose the finished test case. Call this once you are confident, and only after " +
      "run_query has shown you what the query returns.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "what it asserts, as a sentence in the lab's voice" },
        kind: { type: "string", enum: ["query", "probe"] },
        sql: { type: "string", description: "for kind=query: a SELECT returning ONE number" },
        probe_path: { type: "string", description: "for kind=probe: a path on this server, e.g. /api/gallery" },
        probe_method: { type: "string", enum: ["GET", "POST"] },
        op: { type: "string", enum: ["eq", "ne", "lt", "lte", "gt", "gte"] },
        expected: { type: "number" },
        category: { type: "string", description: "the name of an existing category" },
        rationale: { type: "string", description: "why this is the right assertion, and what it would catch" },
      },
      required: ["name", "kind", "op", "expected", "rationale"],
    },
  },
];

function systemPrompt(categories, existingNames) {
  return `You help design ONE test case for the Anima Test Lab. You are an assistant, not a
watcher: you diagnose nothing and monitor nothing — you help write a single assertion, check
it against the real database, and hand it back.

WHAT A TEST CASE IS. Either:
  - a QUERY: one SELECT returning a single number, compared to an expected number; or
  - a PROBE: an anonymous HTTP request to a path on this server, whose STATUS CODE is
    compared to an expected number.

THE HOUSE STYLE, which matters more than it looks:
  - Count the VIOLATIONS and expect 0. "SELECT COUNT(*) ... WHERE <the bad thing>" with
    expected 0 reads as an invariant and stays readable when it fails.
  - The NAME is the invariant stated as a fact, in the lab's voice: "no deployed character
    is a minor", "a share link never grants copy", "the door does not say who exists". Not
    "test that..." and not a bug report.
  - A count of 0 indicts your QUERY before it indicts the code. Before proposing, run a
    positive control through the same joins — prove the query can return non-zero, or that
    the rows you are filtering exist at all. Say what control you ran.
  - An empty table proves nothing. If the thing you are asserting over has no rows yet, say
    so plainly: the case will skip, and that is honest.
  - A probe asserts what an ANONYMOUS request gets. The valuable ones are refusals: a door
    that must answer 401 to a stranger.

WHAT YOU MAY NOT DO. Your queries run on a read-only connection, so nothing you write can
change anything — but do not try. Do not propose a case that depends on data you would have
to create first.

CATEGORIES (a case must belong to one, and it must be one of these):
${categories.map((c) => `  - ${c.name}`).join("\n")}

TEST CASES THAT ALREADY EXIST — do not duplicate one; if the user's idea is already covered,
say which case covers it and offer a sharper variant instead:
${existingNames.map((n) => `  - ${n}`).join("\n")}

HOW TO WORK. Look at the schema. Try the query. Tell the user what it returns today and
whether that means pass or fail. Then call propose_test_case. If the user's intent is vague,
ask one specific question rather than guessing. Keep your prose short — a few sentences, not
an essay.`;
}

async function anthropic(key, body) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// One turn of the conversation. `messages` is the whole thread so far in the
// Anthropic shape; the caller keeps it and sends it back, so the assistant is
// stateless here and the thread lives with the person having it.
export async function assist({ messages }) {
  const key = process.env.CLAUDE_API_KEY;
  if (!key) throw new Error("no CLAUDE_API_KEY set — the assistant cannot run");

  const categories = cases.listCategories();
  const existing = cases.catalogue().map((c) => c.check_name);
  const system = systemPrompt(categories, existing);

  const thread = [...messages];
  let proposal = null;
  const trace = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await anthropic(key, {
      model: MODEL, max_tokens: 2000, system, tools: TOOLS, messages: thread,
    });

    const text = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    const calls = (res.content || []).filter((c) => c.type === "tool_use");

    if (!calls.length) {
      thread.push({ role: "assistant", content: res.content });
      return { reply: text, draft: proposal, trace, messages: thread };
    }

    thread.push({ role: "assistant", content: res.content });
    const results = [];
    for (const call of calls) {
      let out;
      try {
        if (call.name === "list_schema") {
          out = cases.schemaSummary().join("\n");
        } else if (call.name === "run_query") {
          const rows = cases.readQuery(call.input.sql);
          trace.push({ sql: call.input.sql, rows });
          out = JSON.stringify(rows);
        } else if (call.name === "propose_test_case") {
          const cat = categories.find((c) => c.name === call.input.category);
          proposal = { ...call.input, category_id: cat?.id || null };
          out = cat
            ? "Proposal received and shown to the user."
            : `No category named "${call.input.category}". Pick one of: ${categories.map((c) => c.name).join(", ")}`;
          if (!cat) proposal = null;
        } else {
          out = `unknown tool ${call.name}`;
        }
      } catch (e) {
        // A tool error is information for the assistant, not a crash: a query
        // that SQLite refused is exactly what it needs to see to fix it.
        out = `error: ${e.message}`;
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: String(out).slice(0, 8000) });
    }
    thread.push({ role: "user", content: results });
  }

  return {
    reply: "I ran out of steps before settling on a case — tell me which part to focus on.",
    draft: proposal, trace, messages: thread,
  };
}
