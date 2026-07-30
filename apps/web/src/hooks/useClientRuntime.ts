import { Client, type ClientSnapshot, clearClientMetadata } from "@plakk/client-runtime";
import type { User } from "@plakk/shared";
import { useAccessToken } from "@workos/authkit-tanstack-react-start/client";
import { Effect, Stream } from "effect";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  databaseLockNameFor,
  databaseNameFor,
  makeClientRuntime,
  makeSqliteLayer,
  type ClientResource,
  type RunClient,
  runtimeChannelNameFor,
} from "../runtime/client.ts";

export type ClientRuntimeIssue = "another-tab" | "session" | "startup";

export function useClientRuntime(user: User | null) {
  const accessToken = useAccessToken();
  const tabIdRef = useRef(crypto.randomUUID());
  const getAccessTokenRef = useRef(accessToken.getAccessToken);
  getAccessTokenRef.current = accessToken.getAccessToken;
  const resourceRef = useRef<ClientResource | null>(null);
  const disposalRef = useRef<Promise<void>>(Promise.resolve());
  const signingOutRef = useRef(false);
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const [runtimeIssue, setRuntimeIssue] = useState<ClientRuntimeIssue | null>(null);
  const [loading, setLoading] = useState(user !== null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (user === null) {
      signingOutRef.current = false;
      setSnapshot(null);
      setLoading(false);
      setRuntimeIssue(null);
      return;
    }

    let active = true;
    const abortController = new AbortController();
    signingOutRef.current = false;
    setLoading(true);
    setRuntimeIssue(null);
    setSnapshot(null);
    let runtime: ClientResource["runtime"] | null = null;
    let runtimeDisposal: Promise<void> | null = null;
    const disposeRuntime = () => {
      if (runtimeDisposal !== null) return runtimeDisposal;
      const acquiredRuntime = runtime;
      if (acquiredRuntime === null) return Promise.resolve();
      runtime = null;
      if (resourceRef.current?.runtime === acquiredRuntime) resourceRef.current = null;
      runtimeDisposal = acquiredRuntime.dispose();
      disposalRef.current = runtimeDisposal.catch(() => {});
      return runtimeDisposal;
    };
    const runtimeChannel = new BroadcastChannel(runtimeChannelNameFor(user.id));
    runtimeChannel.addEventListener("message", (event) => {
      if (event.data?.type !== "release" || event.data.sourceTabId === tabIdRef.current) return;
      active = false;
      abortController.abort();
      setSnapshot(null);
      setLoading(false);
      setRuntimeIssue(null);
      void (async () => {
        await disposeRuntime();
        window.location.assign("/api/auth/sign-out");
      })();
    });

    const runWithLock = async () => {
      if (!active) return;
      setLoading(true);
      setRuntimeIssue(null);
      try {
        const acquiredRuntime = makeClientRuntime(user, () => getAccessTokenRef.current());
        runtime = acquiredRuntime;
        await acquiredRuntime.runPromise(
          Effect.gen(function* () {
            const client = yield* Client;
            if (active) resourceRef.current = { client, runtime: acquiredRuntime };
            yield* client.subscribe().pipe(
              Stream.runForEach((next) =>
                Effect.sync(() => {
                  if (!active) return;
                  setSnapshot(next);
                  setLoading(false);
                }),
              ),
            );
          }),
        );
      } finally {
        await disposeRuntime();
      }
    };

    void (async () => {
      await disposalRef.current;
      if (!active) return;
      const acquiredImmediately = await navigator.locks.request(
        databaseLockNameFor(user.id),
        { ifAvailable: true },
        async (lock) => {
          if (lock === null) return false;
          await runWithLock();
          return true;
        },
      );
      if (acquiredImmediately || !active) return;
      setLoading(false);
      setRuntimeIssue("another-tab");
      await navigator.locks.request(
        databaseLockNameFor(user.id),
        { signal: abortController.signal },
        runWithLock,
      );
    })().catch(() => {
      if (!active || signingOutRef.current) return;
      setLoading(false);
      setRuntimeIssue("startup");
    });

    return () => {
      active = false;
      abortController.abort();
      runtimeChannel.close();
      void disposeRuntime().catch(() => {});
    };
  }, [attempt, user?.id]);

  const run = useCallback<RunClient>(async (operation) => {
    const resource = resourceRef.current;
    if (resource === null) throw new Error("Plakk is still starting.");
    return resource.runtime.runPromise(operation(resource.client));
  }, []);

  const signOut = useCallback(async () => {
    if (user === null) return;
    signingOutRef.current = true;
    setRuntimeIssue(null);
    try {
      const resource = resourceRef.current;
      resourceRef.current = null;
      if (resource !== null) {
        const disposal = resource.runtime.dispose();
        disposalRef.current = disposal.catch(() => {});
        await disposal;
      }

      const runtimeChannel = new BroadcastChannel(runtimeChannelNameFor(user.id));
      runtimeChannel.postMessage({ type: "release", sourceTabId: tabIdRef.current });
      runtimeChannel.close();

      await navigator.locks.request(databaseLockNameFor(user.id), async () => {
        await Effect.runPromise(
          clearClientMetadata(user.id).pipe(
            Effect.provide(makeSqliteLayer(databaseNameFor(user.id))),
          ),
        );
      });
      window.location.assign("/api/auth/sign-out");
    } catch (cause) {
      signingOutRef.current = false;
      setAttempt((current) => current + 1);
      throw cause;
    }
  }, [user?.id]);

  return {
    issue:
      runtimeIssue ??
      (snapshot?.syncStatus === "SESSION_ERROR" ? "session" : null) ??
      (accessToken.error === null || accessToken.error === undefined ? null : "session"),
    loading,
    snapshot,
    run,
    refresh: () => {
      if (resourceRef.current === null) {
        setAttempt((current) => current + 1);
        return Promise.resolve();
      }
      return run((client) => client.refresh);
    },
    signOut,
  };
}
