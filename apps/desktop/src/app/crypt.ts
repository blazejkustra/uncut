// How generator keys and remote tokens are wrapped: safeStorage, or the tests' stand-in.
import { safeStorage } from "electron";
import type { Crypt } from "../environments.ts";
import { testKeys } from "./testMode.ts";

// ---- environments (Phase 9, D106) ----

// Generator keys and remote tokens are both wrapped by safeStorage (D99), or by the test stand-in.
export const crypt: Crypt = testKeys
  ? {
      encrypt: (text) => `test-standin:${Buffer.from(text, "utf8").toString("base64")}`,
      decrypt: (data) => {
        if (!data.startsWith("test-standin:")) throw new Error("not a test key");
        return Buffer.from(data.slice("test-standin:".length), "base64").toString("utf8");
      },
    }
  : {
      encrypt: (text) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("This Mac's Keychain isn't available to Uncut.");
        return safeStorage.encryptString(text).toString("base64");
      },
      decrypt: (data) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error("This Mac's Keychain isn't available to Uncut.");
        return safeStorage.decryptString(Buffer.from(data, "base64"));
      },
    };
