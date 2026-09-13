import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTokenHistoryFileStore } from "./tokenHistoryFileStore";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sparkrun-token-history-"));
  tempDirs.push(directory);
  return directory;
}

async function ndjsonFiles(directory: string): Promise<string[]> {
  return (await readdir(directory))
    .filter((file) => file.endsWith(".ndjson"))
    .map((file) => join(directory, file));
}

describe("createTokenHistoryFileStore", () => {
  it("retains observations across a store restart", async () => {
    const directory = await tempDir();
    const first = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    await first.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    await first.close();

    const second = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    const result = await second.query({ cluster: "c032", range: "15m", nowMs: 60_000 });
    await second.close();

    expect(result.points.some((point) => point.tokensPerSecond === 7)).toBe(true);
  });

  it("keeps a five-second sample in the minute tier after the rolling tier expires", async () => {
    const directory = await tempDir();
    let nowMs = 60_000;
    const store = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    await store.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    nowMs = 21 * 60_000;
    await store.record({
      atMs: nowMs,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 11,
    });

    const result = await store.query({ cluster: "c032", range: "1d", nowMs });
    await store.close();

    expect(result.points.map((point) => point.tokensPerSecond)).toContain(7);
    expect(result.points.map((point) => point.tokensPerSecond)).toContain(11);
  });

  it("keeps the weighted average when a minute aggregate is reloaded", async () => {
    const directory = await tempDir();
    let nowMs = 60_000;
    const first = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    await first.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 10,
    });
    nowMs = 21 * 60_000;
    await first.record({
      atMs: 20_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 20,
    });
    await first.close();

    const second = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    const result = await second.query({ cluster: "c032", range: "1d", nowMs });
    await second.close();

    expect(result.points.map((point) => point.tokensPerSecond)).toContain(15);
  });

  it("drops observations older than the thirty-one-day retention window", async () => {
    const directory = await tempDir();
    let nowMs = 60_000;
    const store = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    await store.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    nowMs = 32 * 24 * 60 * 60_000;
    await store.record({
      atMs: nowMs,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 11,
    });

    const result = await store.query({ cluster: "c032", range: "30d", nowMs });
    await store.close();

    expect(result.points.map((point) => point.tokensPerSecond)).not.toContain(7);
    expect(result.points.map((point) => point.tokensPerSecond)).toContain(11);
  });

  it("ignores a truncated final NDJSON record", async () => {
    const directory = await tempDir();
    const store = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    await store.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    await store.close();

    const [path] = await ndjsonFiles(directory);
    await appendFile(path, '{"atMs":');

    const recovered = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    const result = await recovered.query({ cluster: "c032", range: "15m", nowMs: 60_000 });
    await recovered.close();

    expect(result.points.map((point) => point.tokensPerSecond)).toContain(7);
  });

  it("degrades coverage instead of failing on a malformed non-final record", async () => {
    const directory = await tempDir();
    const store = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    await store.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    await store.close();

    const [path] = await ndjsonFiles(directory);
    await appendFile(
      path,
      'not-json\n{"atMs":11000,"cluster":"c032","fingerprint":"host-a","tokensPerSecond":9}\n',
    );

    const recovered = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    const result = await recovered.query({ cluster: "c032", range: "15m", nowMs: 60_000 });
    await recovered.close();

    expect(result.state).toBe("partial");
    expect(result.points.map((point) => point.tokensPerSecond)).toContain(8);
  });

  it("rejects path separators in a cluster identifier", async () => {
    const directory = await tempDir();
    const store = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });

    await expect(
      store.record({
        atMs: 10_000,
        cluster: "../escape",
        fingerprint: "host-a",
        tokensPerSecond: 7,
      }),
    ).rejects.toThrow(/cluster/i);
    await store.close();
  });

  it("starts a new series when the host fingerprint changes", async () => {
    const directory = await tempDir();
    let nowMs = 60_000;
    const store = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    await store.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    nowMs = 70_000;
    await store.record({
      atMs: nowMs,
      cluster: "c032",
      fingerprint: "host-b",
      tokensPerSecond: 11,
    });

    const result = await store.query({ cluster: "c032", range: "15m", nowMs });
    await store.close();

    expect(result.fingerprint).toBe("host-b");
    expect(result.points.map((point) => point.tokensPerSecond)).toContain(11);
    expect(result.points.map((point) => point.tokensPerSecond)).not.toContain(7);
  });

  it("keeps the later fingerprint when compacted observations share a minute", async () => {
    const directory = await tempDir();
    let nowMs = 60_000;
    const first = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    await first.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    nowMs = 21 * 60_000;
    await first.record({
      atMs: 20_000,
      cluster: "c032",
      fingerprint: "host-b",
      tokensPerSecond: 11,
    });
    await first.close();

    const second = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    const result = await second.query({ cluster: "c032", range: "1d", nowMs });
    await second.close();

    expect(result.fingerprint).toBe("host-b");
    expect(result.points.map((point) => point.tokensPerSecond)).toContain(11);
    expect(result.points.map((point) => point.tokensPerSecond)).not.toContain(7);
  });
});
