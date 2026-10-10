import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, renameSync, rmSync, fsyncSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 写临时文件、fsync 后再 rename，崩溃时要么看到旧文件，要么看到完整的新文件。 */
export function writeJsonAtomic(file: string, value: unknown, space?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, space));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
  }
}
