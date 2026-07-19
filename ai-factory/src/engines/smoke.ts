import { claudeCode } from "./claude-code";

async function main() {
  const result = await claudeCode.run({
    role: "plan",
    instructions:
      "Jesteś plannerem. Wypisz 3 najważniejsze pliki tego projektu i zaproponuj krótki plan uzupełnienia README.",
    context: "",
    workspace: process.cwd(),
    budget: { minutes: 3 },
    model: "sonnet"
  });

  console.log("ok:", result.ok);
  console.log("costUsd:", result.costUsd);
  console.log("---- report ----\n" + result.report);
}

main();