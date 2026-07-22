import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const normalize = (path: string) => path.trim().replace(/^\.\//, "").replace(/\\/g, "/");

/** Odczyt statusu NUL-separated nie psuje ścieżek ze spacjami ani rename'ów. */
export async function changedFilesInWorkspace(cwd: string): Promise<string[]> {
  const { stdout } = await exec(
    "git",
    ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  const records = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.push(normalize(record.slice(3)));
    if (/[RC]/.test(code) && records[i + 1]) paths.push(normalize(records[++i]));
  }
  return [...new Set(paths.filter(Boolean))];
}

export function undeclaredChangedFiles(declaredFiles: string[], changedFiles: string[]): string[] {
  const declared = new Set(declaredFiles.map(normalize).filter(Boolean));
  return [...new Set(changedFiles.map(normalize).filter((path) => path && !declared.has(path)))];
}
