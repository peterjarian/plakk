const webdriver = "http://127.0.0.1:4444";
const databaseId = `e2e-${Date.now()}`;

const request = async (path, init = {}) => {
  const response = await fetch(`${webdriver}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = await response.json();
  if (!response.ok || body.value?.error) {
    throw new Error(`WebDriver request failed: ${JSON.stringify(body)}`);
  }
  return body.value;
};

const session = await request("/session", {
  method: "POST",
  body: JSON.stringify({
    capabilities: {
      alwaysMatch: {
        "moz:firefoxOptions": { args: ["-headless"] },
      },
    },
  }),
});

const sessionId = session.sessionId;

try {
  await request(`/session/${sessionId}/url`, {
    method: "POST",
    body: JSON.stringify({
      url: `http://localhost:4179/?db=${databaseId}&tab=first`,
    }),
  });

  await request(`/session/${sessionId}/timeouts`, {
    method: "POST",
    body: JSON.stringify({ script: 120_000 }),
  });

  const result = await request(`/session/${sessionId}/execute/async`, {
    method: "POST",
    body: JSON.stringify({
      args: [],
      script: `
        const finish = arguments[arguments.length - 1];
        const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
        const waitFor = async (predicate, description) => {
          for (let attempt = 0; attempt < 400; attempt += 1) {
            if (predicate()) return;
            await delay(25);
          }
          throw new Error(
            "Timed out waiting for " + description +
            "; first=" + JSON.stringify(window.prototypeApi?.state()) +
            "; second=" + JSON.stringify(window.opener?.prototypeApi?.state()),
          );
        };

        let phase = "concurrent initialization";
        let second;
        (async () => {
          second = window.open(
            "?db=${databaseId}&tab=second",
            "_blank",
          );
          if (!second) throw new Error("Firefox blocked the second tab");

          await waitFor(
            () => window.prototypeApi?.state().ready,
            "first tab to initialize",
          );
          await waitFor(
            () => second.prototypeApi?.state().ready,
            "second tab to initialize",
          );

          phase = "reset";
          await window.prototypeApi.reset();
          phase = "initial reads";
          const initial = {
            first: await window.prototypeApi.read(),
            second: await second.prototypeApi.read(),
          };

          phase = "concurrent writes";
          await Promise.all([
            window.prototypeApi.incrementMany(8),
            second.prototypeApi.incrementMany(8),
          ]);

          phase = "post-race reads";
          const afterRace = {
            first: await window.prototypeApi.read(),
            second: await second.prototypeApi.read(),
          };

          phase = "first-tab disposal";
          await window.prototypeApi.dispose();
          phase = "second-tab write after disposal";
          await second.prototypeApi.increment();
          const afterFirstClosed = await second.prototypeApi.read();

          phase = "first-tab reopen";
          await window.prototypeApi.reopen();
          const afterFirstReopened = await window.prototypeApi.read();
          second.close();

          finish({
            initial,
            afterRace,
            afterFirstClosed,
            afterFirstReopened,
          });
        })().catch((error) =>
          finish({
            testError: {
              firstState: window.prototypeApi?.state(),
              message: error.message ?? String(error),
              phase,
              secondState: second?.prototypeApi?.state(),
              stack: error.stack ?? String(error),
            },
          }),
        );
      `,
    }),
  });

  if (result.testError) {
    throw new Error(`${JSON.stringify(result.testError, null, 2)}`);
  }

  const expected = {
    initial: 0,
    afterRace: 16,
    afterFirstClosed: 17,
    afterFirstReopened: 17,
    migrationCount: 1,
  };
  const actual = {
    initial: result.initial.first.value,
    afterRace: result.afterRace.first.value,
    afterFirstClosed: result.afterFirstClosed.value,
    afterFirstReopened: result.afterFirstReopened.value,
    migrationCount: result.afterFirstReopened.migrationCount,
  };

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Unexpected prototype result:\n${JSON.stringify({ expected, actual, result }, null, 2)}`,
    );
  }

  console.log(JSON.stringify({ databaseId, ...result }, null, 2));
} finally {
  await request(`/session/${sessionId}`, { method: "DELETE" });
}
