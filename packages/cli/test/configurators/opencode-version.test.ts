import { execFileSync } from "node:child_process";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { warnIfOpenCodeBelowV2 } from "../../src/configurators/opencode.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockedExec = vi.mocked(execFileSync);

describe("warnIfOpenCodeBelowV2", () => {
  let stderrSpy: MockInstance;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockedExec.mockReset();
  });

  function stderrOutput(): string {
    return stderrSpy.mock.calls.map((call) => String(call[0])).join("");
  }

  it("is silent when the opencode binary does not exist (ENOENT)", () => {
    mockedExec.mockImplementation(() => {
      throw Object.assign(new Error("spawn opencode ENOENT"), {
        code: "ENOENT",
      });
    });
    warnIfOpenCodeBelowV2();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("is silent when opencode --version exits non-zero", () => {
    mockedExec.mockImplementation(() => {
      throw new Error("Command failed: opencode --version");
    });
    warnIfOpenCodeBelowV2();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("is silent when opencode --version times out", () => {
    mockedExec.mockImplementation(() => {
      throw Object.assign(new Error("spawnSync opencode ETIMEDOUT"), {
        code: "ETIMEDOUT",
      });
    });
    warnIfOpenCodeBelowV2();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("is silent when the version output cannot be parsed", () => {
    mockedExec.mockReturnValue("not a version string" as never);
    warnIfOpenCodeBelowV2();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("is silent for OpenCode v2", () => {
    mockedExec.mockReturnValue("opencode v2.3.2\n" as never);
    warnIfOpenCodeBelowV2();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("is silent for a bare semver output with major >= 2", () => {
    mockedExec.mockReturnValue("2.3.2\n" as never);
    warnIfOpenCodeBelowV2();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("warns on stderr for OpenCode v1 without throwing", () => {
    mockedExec.mockReturnValue("opencode v1.19.6\n" as never);
    expect(() => warnIfOpenCodeBelowV2()).not.toThrow();
    const output = stderrOutput();
    expect(output).toContain("1.19.6");
    expect(output).toContain("OpenCode v2");
  });

  it("warns for a v1 prerelease version", () => {
    mockedExec.mockReturnValue("opencode v1.0.0-beta.3\n" as never);
    warnIfOpenCodeBelowV2();
    expect(stderrOutput()).toContain("1.0.0");
  });

  it("probes with a bounded timeout", () => {
    mockedExec.mockReturnValue("opencode v2.3.2\n" as never);
    warnIfOpenCodeBelowV2();
    expect(mockedExec).toHaveBeenCalledWith(
      "opencode",
      ["--version"],
      expect.objectContaining({ timeout: expect.any(Number) as number }),
    );
    const options = mockedExec.mock.calls[0]?.[2] as { timeout: number };
    expect(options.timeout).toBeLessThanOrEqual(3000);
  });
});
