import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startupEvents = vi.hoisted(() => [] as string[]);

const mockListen = vi.fn((_port: number | string, callback?: () => void) => {
  startupEvents.push("listen");
  callback?.();
});

vi.mock("./app", () => {
  startupEvents.push("app-import");
  return {
    default: {
      listen: mockListen,
    },
  };
});

vi.mock("./lib/scheduler", () => ({
  startScheduler: vi.fn(() => {
    startupEvents.push("scheduler-start");
    return { stop: vi.fn() };
  }),
}));

vi.mock("./lib/secrets", () => ({
  initializeSecrets: vi.fn(async () => {
    startupEvents.push("secrets");
  }),
}));

describe("server startup validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    startupEvents.length = 0;
    process.env = { ...originalEnv };
    process.env.NODE_ENV = "production";
    process.env.PORT = "4000";
    process.env.PAYU_KEY = "test_key";
    process.env.PAYU_SALT = "test_salt";
    process.env.PAYU_SURL = "https://example.com/payu/success";
    process.env.PAYU_FURL = "https://example.com/payu/failure";
    delete process.env.PAYU_PAYOUT_KEY;
    delete process.env.PAYU_PAYOUT_SALT;
    delete process.env.PAYU_PAYOUT_ENV;
    delete process.env.PAYOUT_PROVIDER;
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("does not require PAYU payout credentials at startup", async () => {
    await expect(import("./index")).resolves.toBeTruthy();
  });

  it("loads secrets before importing the application or starting the scheduler", async () => {
    await import("./index");

    await vi.waitFor(() => expect(startupEvents).toContain("scheduler-start"));

    expect(startupEvents[0]).toBe("secrets");
    expect(startupEvents.indexOf("app-import")).toBeGreaterThan(startupEvents.indexOf("secrets"));
    expect(startupEvents.indexOf("listen")).toBeGreaterThan(startupEvents.indexOf("secrets"));
    expect(startupEvents.indexOf("scheduler-start")).toBeGreaterThan(startupEvents.indexOf("listen"));
  });
});
