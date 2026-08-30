import { ProjectLocatorInvalidError } from "./errors.js";

declare const projectNameBrand: unique symbol;
declare const projectHandleBrand: unique symbol;
declare const projectLocatorBrand: unique symbol;

export type ProjectName = string & { readonly [projectNameBrand]: true };
export type ProjectHandle = string & { readonly [projectHandleBrand]: true };
export type ProjectLocator = string & { readonly [projectLocatorBrand]: true };

const MAX_PROJECT_NAME_CODE_POINTS = 50;
const MAX_PROJECT_NAME_BYTES = 400;

export function createProjectName(value: string): ProjectName {
  const codePoints = [...value];
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.normalize("NFC") !== value ||
    codePoints.length > MAX_PROJECT_NAME_CODE_POINTS ||
    Buffer.byteLength(value, "utf8") > MAX_PROJECT_NAME_BYTES ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new TypeError("Project name is invalid.");
  }
  return value as ProjectName;
}

export function createOpaqueProjectHandle(value: string): ProjectHandle {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError("Project handle source is invalid.");
  }
  return `prj_${value}` as ProjectHandle;
}

export function createProjectLocator(value: string): ProjectLocator {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProjectLocatorInvalidError();
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "chatgpt.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !/^\/g\/g-p-[0-9a-f]{32}\/project\/?$/.test(url.pathname)
  ) {
    throw new ProjectLocatorInvalidError();
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "") as ProjectLocator;
}
