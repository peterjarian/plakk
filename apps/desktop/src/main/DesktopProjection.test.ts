import type { User } from "@plakk/shared";
import type { AccountStatus, PipeConnection } from "@plakk/shared/PlakkApi";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ElectronStore from "electron-store";

import type { DesktopSnippet } from "../ipc/contracts.ts";
import {
  DesktopProjection,
  DesktopProjectionStore,
  DesktopSnippetProjector,
} from "./DesktopProjection.ts";

const user = (id: string): User => ({
  id,
  email: `${id}@example.com`,
  firstName: id,
  lastName: "User",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const snippet = (id: string, fileName: string): DesktopSnippet => ({
  id,
  fileName,
  byteSize: 4,
  storageProvider: "GOOGLE_DRIVE",
  uploadStatus: "UPLOADED",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  localState: null,
  localTextPreview: "test",
  localContentAvailability: { status: "AVAILABLE" },
});

const onlineAccount: AccountStatus = {
  canSync: true,
  storageProvider: "GOOGLE_DRIVE",
  blockedReasons: [],
};

const connected: PipeConnection = {
  storageProvider: "GOOGLE_DRIVE",
  status: "CONNECTED",
  externalDestinationUrl: "https://drive.example.com/folder",
};

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const makeRuntime = (
  cwd: string,
  items: Readonly<Record<string, ReadonlyArray<DesktopSnippet>>>,
) => {
  const projector = Layer.succeed(
    DesktopSnippetProjector,
    DesktopSnippetProjector.of({
      changes: Stream.empty,
      project: (accountId) => Effect.succeed(items[accountId] ?? []),
    }),
  );
  const store = DesktopProjectionStore.layer({ cwd });
  return ManagedRuntime.make(
    DesktopProjection.layer.pipe(Layer.provide(Layer.merge(store, projector))),
  );
};

describe("desktop projection", () => {
  it("restores cached account, provider, and snippets offline after a restart", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "plakk-projection-"));
    temporaryDirectories.push(cwd);
    const firstSnippet = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "first.txt");
    const account = user("user_1");

    const firstRuntime = makeRuntime(cwd, { [account.id]: [firstSnippet] });
    await firstRuntime.runPromise(
      DesktopProjection.use((projection) =>
        projection.update({
          kind: "online",
          account,
          accountStatus: onlineAccount,
          connection: connected,
        }),
      ),
    );
    await firstRuntime.dispose();

    const restartedRuntime = makeRuntime(cwd, { [account.id]: [firstSnippet] });
    const restored = await restartedRuntime.runPromise(
      DesktopProjection.use((projection) => projection.current),
    );
    await restartedRuntime.dispose();

    expect(restored).toMatchObject({
      account,
      provider: { known: true, value: "GOOGLE_DRIVE" },
      capability: { status: "OFFLINE" },
      snippets: [firstSnippet],
    });
  });

  it("switches account-scoped projections without leaking the previous account", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "plakk-projection-"));
    temporaryDirectories.push(cwd);
    const firstAccount = user("user_1");
    const secondAccount = user("user_2");
    const firstSnippet = snippet("0d1e2f3a-4567-4890-8abc-def012345678", "first.txt");
    const secondSnippet = snippet("1d1e2f3a-4567-4890-8abc-def012345679", "second.txt");
    const runtime = makeRuntime(cwd, {
      [firstAccount.id]: [firstSnippet],
      [secondAccount.id]: [secondSnippet],
    });

    await runtime.runPromise(
      DesktopProjection.use((projection) =>
        projection.update({
          kind: "online",
          account: firstAccount,
          accountStatus: onlineAccount,
          connection: connected,
        }),
      ),
    );
    await runtime.runPromise(
      DesktopProjection.use((projection) =>
        projection.update({ kind: "offline", account: secondAccount }),
      ),
    );
    const switched = await runtime.runPromise(
      DesktopProjection.use((projection) => projection.current),
    );
    await runtime.dispose();

    expect(switched.account).toEqual(secondAccount);
    expect(switched.provider).toEqual({ known: false, value: null });
    expect(switched.snippets).toEqual([secondSnippet]);
  });

  it("clears the durable display projection on explicit sign-out", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "plakk-projection-"));
    temporaryDirectories.push(cwd);
    const account = user("user_1");
    const runtime = makeRuntime(cwd, { [account.id]: [] });

    await runtime.runPromise(
      DesktopProjection.use((projection) =>
        projection.update({
          kind: "online",
          account,
          accountStatus: onlineAccount,
          connection: connected,
        }),
      ),
    );
    await runtime.runPromise(
      DesktopProjection.use((projection) => projection.update({ kind: "signed-out" })),
    );
    await runtime.dispose();

    const restartedRuntime = makeRuntime(cwd, { [account.id]: [] });
    const restored = await restartedRuntime.runPromise(
      DesktopProjection.use((projection) => projection.current),
    );
    await restartedRuntime.dispose();

    expect(restored).toMatchObject({
      account: null,
      provider: { known: false, value: null },
      capability: { status: "OFFLINE" },
      snippets: [],
    });
  });

  it("recovers from an invalid cached session without failing desktop startup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "plakk-projection-"));
    temporaryDirectories.push(cwd);
    const store = new ElectronStore<{ session: string | null }>({
      cwd,
      name: "desktop-projection",
    });
    store.set("session", "not a valid encoded session");

    const runtime = makeRuntime(cwd, {});
    const projection = await runtime.runPromise(
      DesktopProjection.use((desktop) => desktop.current),
    );
    await runtime.dispose();

    expect(projection).toEqual({
      revision: 0,
      account: null,
      provider: { known: false, value: null },
      capability: { status: "OFFLINE" },
      snippets: [],
    });
    expect(store.get("session")).toBeNull();
  });
});
