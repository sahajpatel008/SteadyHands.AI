const PREFIX = "[SH]";

function ts() {
  return new Date().toISOString();
}

export function log(tag: string, message: string, data?: unknown) {
  const line = `${PREFIX}[${ts()}][${tag}] ${message}`;
  console.log(line);
  if (data !== undefined) {
    console.log(
      typeof data === "object" && data !== null
        ? JSON.stringify(data, null, 2)
        : String(data),
    );
  }
}

export function logMain(tag: string, message: string, data?: unknown) {
  log(`main:${tag}`, message, data);
}

export function logRenderer(tag: string, message: string, data?: unknown) {
  log(`renderer:${tag}`, message, data);
}
