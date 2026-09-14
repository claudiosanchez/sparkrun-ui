import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTokenHistoryFileStore } from "./tokenHistoryFileStore";

const nativeFileSystem = { mkdir, readFile, readdir, rename, unlink, writeFile };

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
  it("accepts the five-minute range without a range-specific failure", async () => {
    const directory = await tempDir();
    const store = createTokenHistoryFileStore({ dataDir: directory, now: () => 300_000 });

    const result = await store.query({ cluster: "c032", range: "5m", nowMs: 300_000 });
    await store.close();

    expect(result).toMatchObject({ cluster: "c032", range: "5m", state: "empty" });
    expect(result.points).toHaveLength(300);
  });

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

  it("does not lose an aged sample when writing the minute tier fails", async () => {
    const directory = await tempDir();
    let nowMs = 60_000;
    const failingFileSystem = {
      ...nativeFileSystem,
      writeFile: async (path: string, data: string, encoding: "utf8") => {
        if (path.includes("/day-")) throw new Error("injected day write failure");
        return writeFile(path, data, encoding);
      },
    };
    const first = createTokenHistoryFileStore({
      dataDir: directory,
      now: () => nowMs,
      fileSystem: failingFileSystem,
    });
    await first.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    nowMs = 21 * 60_000;
    await expect(
      first.record({
        atMs: nowMs,
        cluster: "c032",
        fingerprint: "host-a",
        tokensPerSecond: 11,
      }),
    ).rejects.toThrow("injected day write failure");

    const second = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    const result = await second.query({ cluster: "c032", range: "1d", nowMs });
    await second.close();

    expect(result.points.map((point) => point.tokensPerSecond)).toContain(7);
  });

  it("keeps the durable sample exactly once when rolling rename fails", async () => {
    const directory = await tempDir();
    let nowMs = 60_000;
    let failRollingRename = false;
    const renameTargets: string[] = [];
    const failingFileSystem = {
      ...nativeFileSystem,
      rename: async (oldPath: string, newPath: string) => {
        renameTargets.push(newPath);
        if (failRollingRename && newPath.includes("/rolling-")) {
          throw new Error("injected rolling rename failure");
        }
        return rename(oldPath, newPath);
      },
    };
    const first = createTokenHistoryFileStore({
      dataDir: directory,
      now: () => nowMs,
      fileSystem: failingFileSystem,
    });
    await first.record({
      atMs: 0,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    renameTargets.length = 0;
    nowMs = 21 * 60_000;
    failRollingRename = true;
    await expect(
      first.record({
        atMs: nowMs,
        cluster: "c032",
        fingerprint: "host-a",
        tokensPerSecond: 11,
      }),
    ).rejects.toThrow("injected rolling rename failure");
    expect(renameTargets[0]).toContain("/day-");
    expect(renameTargets[1]).toContain("/rolling-");

    const second = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    const result = await second.query({ cluster: "c032", range: "30d", nowMs });
    await second.close();

    expect(
      result.points.map((point) => point.tokensPerSecond).filter((value) => value !== null),
    ).toEqual([7]);
  });

  it("compacts only minutes that are fully closed", async () => {
    const directory = await tempDir();
    let nowMs = 60_000;
    const store = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    await store.record({
      atMs: 0,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });

    nowMs = 20 * 60_000 + 30_000;
    await store.record({
      atMs: nowMs,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 11,
    });
    expect((await ndjsonFiles(directory)).some((path) => path.includes("/day-"))).toBe(false);

    nowMs += 60_000;
    await store.record({
      atMs: nowMs,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 13,
    });
    await store.close();

    expect((await ndjsonFiles(directory)).some((path) => path.includes("/day-"))).toBe(true);
  });

  it("does not rewrite unrelated historic day segments for an ordinary record", async () => {
    const directory = await tempDir();
    let nowMs = 2 * 24 * 60 * 60_000;
    const writes: string[] = [];
    const trackingFileSystem = {
      ...nativeFileSystem,
      writeFile: async (path: string, data: string, encoding: "utf8") => {
        writes.push(path);
        return writeFile(path, data, encoding);
      },
    };
    const store = createTokenHistoryFileStore({
      dataDir: directory,
      now: () => nowMs,
      fileSystem: trackingFileSystem,
    });
    await store.record({
      atMs: nowMs - 24 * 60 * 60_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    expect(writes.some((path) => path.includes("/day-"))).toBe(true);

    writes.length = 0;
    nowMs += 1_000;
    await store.record({
      atMs: nowMs,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 11,
    });
    await store.close();

    expect(writes.some((path) => path.includes("/day-"))).toBe(false);
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
    await appendFile(path, '{"kind":"sample","atMs":');

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
      'not-json\n{"kind":"sample","atMs":11000,"cluster":"c032","fingerprint":"host-a","tokensPerSecond":9}\n',
    );

    const recovered = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    const result = await recovered.query({ cluster: "c032", range: "15m", nowMs: 60_000 });
    await recovered.close();

    expect(result.state).toBe("partial");
    expect(result.points.map((point) => point.tokensPerSecond)).toContain(8);
  });

  it("treats a malformed-only or unknown-kind file as unavailable", async () => {
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
    await writeFile(
      path,
      '{"kind":"unknown","atMs":10000,"cluster":"c032","fingerprint":"host-a","tokensPerSecond":7}\n',
    );

    const recovered = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    const result = await recovered.query({ cluster: "c032", range: "15m", nowMs: 60_000 });
    await recovered.close();

    expect(result.state).toBe("unavailable");
  });

  it("degrades a complete but malformed final record", async () => {
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
    await writeFile(path, '{"kind":"sample","atMs":10000,"cluster":"c032","fingerprint":"host-a"}');

    const recovered = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    const result = await recovered.query({ cluster: "c032", range: "15m", nowMs: 60_000 });
    await recovered.close();

    expect(result.state).toBe("unavailable");
  });

  it("rejects a compacted minute whose latest timestamp is outside its minute", async () => {
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
    await writeFile(
      path,
      '{"kind":"minute","atMs":0,"cluster":"c032","fingerprint":"host-a","tokensPerSecond":7,"weight":1,"latestAtMs":60000}\n',
    );

    const recovered = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    const result = await recovered.query({ cluster: "c032", range: "15m", nowMs: 60_000 });
    await recovered.close();

    expect(result.state).toBe("unavailable");
  });

  it("rejects a raw sample with a non-integral timestamp", async () => {
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
    await writeFile(
      path,
      '{"kind":"sample","atMs":1000.5,"cluster":"c032","fingerprint":"host-a","tokensPerSecond":7}\n',
    );

    const recovered = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    const result = await recovered.query({ cluster: "c032", range: "15m", nowMs: 60_000 });
    await recovered.close();

    expect(result.state).toBe("unavailable");
  });

  it("cleans expired quiet-cluster files when queried", async () => {
    const directory = await tempDir();
    const first = createTokenHistoryFileStore({ dataDir: directory, now: () => 60_000 });
    await first.record({
      atMs: 10_000,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 7,
    });
    await first.close();

    const nowMs = 32 * 24 * 60 * 60_000;
    const second = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    const result = await second.query({ cluster: "c032", range: "30d", nowMs });
    await second.close();

    expect(result.state).toBe("empty");
    expect(await ndjsonFiles(directory)).toHaveLength(0);
  });

  it("rebuilds a partial cache after a transient file read failure", async () => {
    const directory = await tempDir();
    let nowMs = 60_000;
    const first = createTokenHistoryFileStore({ dataDir: directory, now: () => nowMs });
    await first.record({
      atMs: 0,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 10,
    });
    nowMs = 21 * 60_000;
    await first.record({
      atMs: nowMs,
      cluster: "c032",
      fingerprint: "host-a",
      tokensPerSecond: 20,
    });
    await first.close();

    let readCount = 0;
    const flakyFileSystem = {
      ...nativeFileSystem,
      readFile: async (path: string, encoding: "utf8") => {
        readCount += 1;
        if (readCount === 2) throw new Error("injected transient read failure");
        return readFile(path, encoding);
      },
    };
    const recovered = createTokenHistoryFileStore({
      dataDir: directory,
      now: () => nowMs,
      fileSystem: flakyFileSystem,
    });
    const firstQuery = await recovered.query({ cluster: "c032", range: "30d", nowMs });
    expect(firstQuery.state).toBe("unavailable");

    const secondQuery = await recovered.query({ cluster: "c032", range: "30d", nowMs });
    await recovered.close();

    expect(secondQuery.points.map((point) => point.tokensPerSecond)).toContain(15);
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
