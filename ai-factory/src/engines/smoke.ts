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
  
  // test negatywny: 0.05 min = 3 s — agent nie zdąży, proces zostanie ubity
  const timeoutResult = await claudeCode.run({
    role: "plan",
    instructions: "Przeanalizuj dokładnie cały projekt.",
    context: "",
    workspace: process.cwd(),
    budget: { minutes: 0.05 },
  });

  console.log("\n== test negatywny ==");
  console.log("ok:", timeoutResult.ok, "(oczekiwane: false)");
  console.log("report:", timeoutResult.report.slice(0, 200));
}



main();