import { describe, expect, it } from "vitest";
import {
  compareProtocolVersions,
  isSupportedExtensionProtocolVersion,
  PROTOCOL_VERSION,
  SUPPORTED_EXTENSION_PROTOCOL_VERSIONS,
} from "./version.js";

describe("PROTOCOL_VERSION", () => {
  it("matches the package version so a release cannot desync them", async () => {
    const pkg = (await import("../../package.json", { with: { type: "json" } })).default;
    expect(PROTOCOL_VERSION).toBe(pkg.version);
  });

  it("is not a placeholder", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("isSupportedExtensionProtocolVersion", () => {
  it("accepts every advertised version", () => {
    for (const v of SUPPORTED_EXTENSION_PROTOCOL_VERSIONS) {
      expect(isSupportedExtensionProtocolVersion(v)).toBe(true);
    }
  });

  it("refuses unknown, empty and non-string versions", () => {
    expect(isSupportedExtensionProtocolVersion("1.0")).toBe(false);
    expect(isSupportedExtensionProtocolVersion("")).toBe(false);
    expect(isSupportedExtensionProtocolVersion(undefined)).toBe(false);
    expect(isSupportedExtensionProtocolVersion(2.1)).toBe(false);
  });

  it("accepts exactly the version the relay puts on the wire", () => {
    // The relay sends PROTOCOL_VERSION in its hello and its ack, so the two
    // must not drift apart.
    expect(isSupportedExtensionProtocolVersion(PROTOCOL_VERSION)).toBe(true);
    expect(SUPPORTED_EXTENSION_PROTOCOL_VERSIONS).toContain(PROTOCOL_VERSION);
  });

  it("does not accept a prefix or a suffixed variant of a supported version", () => {
    expect(isSupportedExtensionProtocolVersion("2")).toBe(false);
    expect(isSupportedExtensionProtocolVersion("2.1")).toBe(false);
    expect(isSupportedExtensionProtocolVersion(`${PROTOCOL_VERSION}-rc1`)).toBe(false);
  });
});

describe("compareProtocolVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareProtocolVersions("2.10", "2.9")).toBe(1);
    expect(compareProtocolVersions("2.9", "2.10")).toBe(-1);
  });

  it("treats missing components as zero", () => {
    expect(compareProtocolVersions("2.1", "2.1.0")).toBe(0);
    expect(compareProtocolVersions("2", "2.0.1")).toBe(-1);
  });

  it("returns zero for identical versions", () => {
    expect(compareProtocolVersions("2.1", "2.1")).toBe(0);
  });
});
