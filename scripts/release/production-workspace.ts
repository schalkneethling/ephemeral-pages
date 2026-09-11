import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export async function verifyProductionWorkspace(
  repositoryRoot: string,
  workspace: string,
): Promise<void> {
  const [root, directory, metadata] = await Promise.all([
    realpath(repositoryRoot),
    realpath(workspace),
    lstat(workspace),
  ]);
  const path = relative(root, directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !path ||
    (path !== ".." && !path.startsWith(`..${sep}`))
  )
    throw new Error("Invalid existing release workspace.");
  // realpath may normalize the platform's temporary-directory alias (e.g.
  // /tmp on macOS). Child paths must still be resolved under this directory.
  if (resolve(directory) !== directory) throw new Error("Invalid existing release workspace.");
}
