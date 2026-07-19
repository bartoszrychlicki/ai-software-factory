import { createWorkspace, removeWorkspace } from "./workspace";

async function main() {
  const repo = `${process.env.HOME}/Development/Edu/pilot-app`;
  const ws = await createWorkspace(repo, "TEST-1", "smoke");
  console.log("workspace:", ws);
  await removeWorkspace(ws);
  console.log("cleaned up");
}

main();