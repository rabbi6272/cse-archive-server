import { expect, setSystemTime, test } from "bun:test";
import {
  DRIVE_CACHE_REVALIDATE_SECONDS,
  getCachedDriveData,
  invalidateAllDriveCaches,
} from "./cache";

test("serves from cache within TTL, refetches after TTL and after invalidation", async () => {
  let calls = 0;
  const fetchFn = async () => ++calls;
  setSystemTime(new Date("2026-01-01T00:00:00Z"));

  expect(await getCachedDriveData("folderA", fetchFn)).toBe(1);
  expect(await getCachedDriveData("folderA", fetchFn)).toBe(1);

  setSystemTime(new Date(Date.now() + DRIVE_CACHE_REVALIDATE_SECONDS * 1000));
  expect(await getCachedDriveData("folderA", fetchFn)).toBe(2);

  await invalidateAllDriveCaches();
  expect(await getCachedDriveData("folderA", fetchFn)).toBe(3);

  setSystemTime();
});

test("does not cache failed fetches", async () => {
  await invalidateAllDriveCaches();
  const failing = async () => {
    throw new Error("drive down");
  };
  await expect(getCachedDriveData("folderB", failing)).rejects.toThrow("drive down");
  expect(await getCachedDriveData("folderB", async () => "ok")).toBe("ok");
});
