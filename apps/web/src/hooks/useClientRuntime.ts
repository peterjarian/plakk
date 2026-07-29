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
  messageFrom,
  type ClientResource,
  type RunClient,
  runtimeChannelNameFor,
} from "../runtime/client.ts";

export function useClientRuntime(user: User | null) {
  const accessToken = useAccessToken();
  const tabIdRef = useRef(crypto.randomUUID());
  const getAccessTokenRef = useRef(accessToken.getAccessToken);
  getAccessTokenRef.current = accessToken.getAccessToken;
  const resourceRef = useRef<ClientResource | null>(null);
  const [snapshot, setSnapshot] = useState<ClientSnapshot | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [loading, setLoading] = useState(user !== null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (user === null) {
      setSnapshot(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setRuntimeError(null);
    setSnapshot(null);
    const lockAbort = new AbortController();
    let runtime: ClientResource["runtime"] | null = null;
    const runtimeChannel = new BroadcastChannel(runtimeChannelNameFor(user.id));
    runtimeChannel.addEventListener("message", (event) => {
      if (event.data?.type !== "release" || event.data.sourceTabId === tabIdRef.current) return;
      active = false;
      lockAbort.abort();
      const acquiredRuntime = runtime;
      runtime = null;
      if (resourceRef.current?.runtime === acquiredRuntime) resourceRef.current = null;
      setSnapshot(null);
      setLoading(false);
      setRuntimeError(null);
      void (async () => {
        if (acquiredRuntime !== null) await acquiredRuntime.dispose();
        window.location.assign("/api/auth/sign-out");
      })();
    });

    void navigator.locks
      .request(
        databaseLockNameFor(user.id),
        { ifAvailable: true, signal: lockAbort.signal },
        async (lock) => {
          if (lock === null) {
            if (active) {
              setLoading(false);
              setRuntimeError("Plakk is already open in another browser tab.");
            }
            return;
          }
          if (!active) return;
          const acquiredRuntime = makeClientRuntime(user, () => getAccessTokenRef.current());
          runtime = acquiredRuntime;
          try {
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
            if (resourceRef.current?.runtime === acquiredRuntime) resourceRef.current = null;
            if (runtime === acquiredRuntime) runtime = null;
            await acquiredRuntime.dispose();
          }
        },
      )
      .catch((cause) => {
        if (!active) return;
        setLoading(false);
        setRuntimeError(messageFrom(cause, "Plakk could not start in this browser."));
      });

    return () => {
      active = false;
      lockAbort.abort();
      runtimeChannel.close();
      const acquiredRuntime = runtime;
      if (acquiredRuntime !== null) {
        if (resourceRef.current?.runtime === acquiredRuntime) resourceRef.current = null;
        void acquiredRuntime.dispose();
      }
    };
  }, [attempt, user?.id]);

  const run = useCallback<RunClient>(async (operation) => {
    const resource = resourceRef.current;
    if (resource === null) throw new Error("Plakk is still starting.");
    return resource.runtime.runPromise(operation(resource.client));
  }, []);

  const signOut = useCallback(async () => {
    if (user === null) return;
    try {
      const resource = resourceRef.current;
      resourceRef.current = null;
      if (resource !== null) await resource.runtime.dispose();

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
    } finally {
      window.location.assign("/api/auth/sign-out");
    }
  }, [user?.id]);

  return {
    error: runtimeError ?? accessToken.error?.message ?? null,
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
