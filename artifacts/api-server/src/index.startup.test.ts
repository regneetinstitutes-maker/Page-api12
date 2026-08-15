import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockListen = vi.fn((_port: number | string, callback?: () => void) => {
  callback?.();
});

vi.mock("./app", () => ({
  default: {
    listen: mockListen,
  },
}));

vi.mock("./lib/scheduler", () => ({
  startScheduler: vi.fn(() => ({ stop: vi.fn() })),
}));

describe("server startup validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
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
});
