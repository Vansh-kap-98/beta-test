import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { HttpSystemOne, createJevClient, createLayaClient } from "../src/core/soc/backends/http.ts";
import type { Question } from "../src/core/soc/types.ts";

/**
 * Wire-contract tests against fixture payloads taken from the published Jev and
 * Laya API documentation.
 *
 * These matter more than they look. The backend cannot be exercised against a live
 * endpoint here, and every one of these mappings is a place where a plausible-looking
 * mistake would corrupt calibration silently rather than throw - reading `noul` as a
 * boolean, or as its own confidence, would poison the escalation gate with no error
 * anywhere.
 */

function fakeFetch(response: unknown, capture?: { body?: any; url?: string; headers?: any }) {
  return (async (url: any, init: any) => {
    if (capture) {
      capture.url = String(url);
      capture.body = JSON.parse(init.body);
      capture.headers = init.headers;
    }
    return {
      ok: true,
      status: 200,
      json: async () => response,
      text: async () => JSON.stringify(response),
    };
  }) as unknown as typeof fetch;
}

describe("http backend: request shape", () => {
  test("sends questions as a keyed map with criteria, per the API contract", async () => {
    const cap: any = {};
    const client = new HttpSystemOne({
      baseUrl: "https://api.example.test",
      apiKey: "k",
      model: "jev-latest",
      fetchImpl: fakeFetch({ answers: {} }, cap),
    });
    const questions: Question[] = [
      {
        id: "has_exit",
        kind: "noul",
        prompt: "Does this screen have an exit?",
        criteria: { true: "an exit control exists", false: "no way out" },
      },
      {
        id: "act",
        kind: "choice",
        prompt: "Which control?",
        options: ["buy_elixir", "back"],
        descriptions: { buy_elixir: "Elixir (80g)", back: "Back" },
      },
      { id: "diff", kind: "score", prompt: "How hard?", min: 1, max: 3, labels: ["easy", "fair", "brutal"] },
    ];
    await client.ask({ screen: "shop" }, questions);

    assert.equal(cap.url, "https://api.example.test/v1/systemone");
    assert.equal(cap.headers["Authorization"], "Bearer k");
    assert.equal(cap.body.model, "jev-latest");
    assert.deepEqual(cap.body.state, { screen: "shop" });

    // A map keyed by question id, not an array.
    assert.deepEqual(Object.keys(cap.body.questions).sort(), ["act", "diff", "has_exit"]);
    assert.equal(cap.body.questions.has_exit.type, "noul");
    assert.deepEqual(cap.body.questions.has_exit.criteria, {
      true: "an exit control exists",
      false: "no way out",
    });
    // Captions reach the model, not bare ids.
    assert.deepEqual(cap.body.questions.act.criteria, {
      buy_elixir: "Elixir (80g)",
      back: "Back",
    });
    assert.deepEqual(cap.body.questions.diff.criteria, ["easy", "fair", "brutal"]);
  });

  test("falls back to option ids when no descriptions are supplied", async () => {
    const cap: any = {};
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({ answers: {} }, cap),
    });
    await client.ask({}, [{ id: "a", kind: "choice", prompt: "p", options: ["x", "y"] }]);
    assert.deepEqual(cap.body.questions.a.criteria, { x: "x", y: "y" });
  });

  test("omits the Authorization header when unauthenticated (local Laya)", async () => {
    const cap: any = {};
    const client = new HttpSystemOne({ baseUrl: "http://localhost:8000", fetchImpl: fakeFetch({ answers: {} }, cap) });
    await client.ask({}, [{ id: "a", kind: "noul", prompt: "p" }]);
    assert.equal(cap.headers["Authorization"], undefined);
  });
});

describe("http backend: noul decoding", () => {
  test("a confident YES maps to value=true with high confidence", async () => {
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({ answers: { q: { type: "noul", noul: 0.95 } } }),
    });
    const [a] = await client.ask({}, [{ id: "q", kind: "noul", prompt: "p" }]);
    assert.equal(a!.kind, "noul");
    assert.equal((a as any).value, true);
    assert.equal(Math.round((a as any).p * 100), 95);
  });

  test("a confident NO maps to value=false with HIGH confidence, not low", async () => {
    // The subtle one. `noul` is P(true), so 0.02 is a firm "no" held with 98%
    // confidence. Reading p=0.02 here would make every confident negative answer
    // look maximally uncertain and would route all of them to Tier 2.
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({ answers: { q: { type: "noul", noul: 0.02 } } }),
    });
    const [a] = await client.ask({}, [{ id: "q", kind: "noul", prompt: "p" }]);
    assert.equal((a as any).value, false);
    assert.equal(Math.round((a as any).p * 100), 98);
  });

  test("a borderline answer reports low confidence and will escalate", async () => {
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({ answers: { q: { type: "noul", noul: 0.51 } } }),
    });
    const [a] = await client.ask({}, [{ id: "q", kind: "noul", prompt: "p" }]);
    assert.ok((a as any).p < 0.6, "borderline must not look confident");
  });
});

describe("http backend: choice decoding", () => {
  test("takes confidence from the chosen option's probability", async () => {
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({
        answers: {
          q: {
            type: "choice",
            choice: "billing",
            probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 },
            confidence: 0.81,
          },
        },
      }),
    });
    const [a] = await client.ask({}, [
      { id: "q", kind: "choice", prompt: "p", options: ["billing", "technical", "sales"] },
    ]);
    assert.equal((a as any).value, "billing");
    assert.equal((a as any).p, 0.88);
    assert.deepEqual((a as any).dist.technical, 0.12);
  });

  test("rejects a choice that was not on the menu", async () => {
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({ answers: { q: { type: "choice", choice: "hallucinated", confidence: 0.9 } } }),
    });
    const [a] = await client.ask({}, [{ id: "q", kind: "choice", prompt: "p", options: ["a", "b"] }]);
    assert.ok(["a", "b"].includes((a as any).value));
  });
});

describe("http backend: score decoding", () => {
  test("shifts a zero-indexed float level onto the question's own range", async () => {
    // Wire score 1.84 over levels [0,1,2] on a 1-5 question means 2.84.
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({ answers: { q: { type: "score", score: 1.84, confidence: 0.65 } } }),
    });
    const [a] = await client.ask({}, [{ id: "q", kind: "score", prompt: "p", min: 1, max: 5 }]);
    assert.equal(Math.round((a as any).value * 100), 284);
    assert.equal((a as any).p, 0.65);
  });

  test("clamps a score that exceeds the declared range", async () => {
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({ answers: { q: { type: "score", score: 99 } } }),
    });
    const [a] = await client.ask({}, [{ id: "q", kind: "score", prompt: "p", min: 1, max: 5 }]);
    assert.equal((a as any).value, 5);
  });
});

describe("http backend: failure handling", () => {
  test("a missing answer becomes a zero-confidence guess, so it escalates", async () => {
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({ answers: {} }),
    });
    const [a] = await client.ask({}, [{ id: "q", kind: "noul", prompt: "p" }]);
    assert.equal((a as any).p, 0, "unknown must never look confident");
  });

  test("retries a 5xx and succeeds", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      if (calls < 3) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ answers: { q: { type: "noul", noul: 0.9 } } }), text: async () => "" };
    }) as unknown as typeof fetch;
    const client = new HttpSystemOne({ baseUrl: "https://x.test", retries: 3, fetchImpl: impl });
    const [a] = await client.ask({}, [{ id: "q", kind: "noul", prompt: "p" }]);
    assert.equal(calls, 3);
    assert.equal((a as any).value, true);
  });

  test("does not retry a 4xx - a bad request will not fix itself", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({}), text: async () => "bad question" };
    }) as unknown as typeof fetch;
    const client = new HttpSystemOne({ baseUrl: "https://x.test", retries: 3, fetchImpl: impl });
    await assert.rejects(() => client.ask({}, [{ id: "q", kind: "noul", prompt: "p" }]));
    assert.equal(calls, 1);
  });

  test("counts tokens for the cost model", async () => {
    const client = new HttpSystemOne({
      baseUrl: "https://x.test",
      fetchImpl: fakeFetch({ answers: {}, usage: { input_tokens: 42, output_tokens: 0 } }),
    });
    await client.ask({}, [{ id: "q", kind: "noul", prompt: "p" }]);
    assert.equal(client.usage.inputTokens, 42);
    assert.equal(client.usage.outputTokens, 0, "System One output is free - that is the point");
  });
});

describe("http backend: presets", () => {
  test("jev preset targets the managed endpoint with the right model", async () => {
    const cap: any = {};
    const c = createJevClient("secret", { fetchImpl: fakeFetch({ answers: {} }, cap) });
    await c.ask({}, [{ id: "q", kind: "noul", prompt: "p" }]);
    assert.equal(cap.url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(cap.headers["Authorization"], "Bearer secret");
    assert.equal(cap.body.model, "jev-latest");
    assert.equal(c.name, "jev");
  });

  test("laya preset targets a local host with no auth", async () => {
    const cap: any = {};
    const c = createLayaClient("http://127.0.0.1:8000", { fetchImpl: fakeFetch({ answers: {} }, cap) });
    await c.ask({}, [{ id: "q", kind: "noul", prompt: "p" }]);
    assert.equal(cap.url, "http://127.0.0.1:8000/v1/systemone");
    assert.equal(cap.headers["Authorization"], undefined);
    assert.equal(c.name, "laya");
  });
});
