import { claudeCode } from "./claude-code";
import { pi } from "./pi";

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
  //console.log("---- report ----\n" + result.report);

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


  // test codexa
  const codexResult = await import("./codex").then((mod) => mod.codex.run({
    role: "plan",
    instructions:
      "Wypisz 3 pliki projektu i jedno zdanie o każdym.",
    context: "",
    workspace: process.cwd(),
    budget: { minutes: 3 },
  }));

    console.log("\n== test codex ==");
    console.log("ok:", codexResult.ok);
    console.log("report:", codexResult.report.slice(0, 200));

  // test pi z lokalnym qwen przez LM Studio
  const piResult = await pi.run({
    role: "verify",
    instructions: "Odpowiedz dokładnie: PI_OK",
    context: "To jest hostowy smoke test adaptera pi.",
    workspace: process.cwd(),
    budget: { minutes: 3 },
    model: "qwen/qwen3.6-27b",
  });

  console.log("\n== test pi ==");
  console.log("ok:", piResult.ok);
  console.log("report:", piResult.report.slice(0, 200));

  const piWrongRole = await pi.run({
    role: "build",
    instructions: "Nie uruchamiaj procesu.",
    context: "",
    workspace: process.cwd(),
    budget: { minutes: 1 },
    model: "qwen/qwen3.6-27b",
  });

  console.log("\n== test negatywny pi: rola build ==");
  console.log("ok:", piWrongRole.ok, "(oczekiwane: false)");
  console.log("report:", piWrongRole.report);

  const piWithoutModel = await pi.run({
    role: "verify",
    instructions: "Nie uruchamiaj procesu.",
    context: "",
    workspace: process.cwd(),
    budget: { minutes: 1 },
  });

  console.log("\n== test negatywny pi: brak modelu ==");
  console.log("ok:", piWithoutModel.ok, "(oczekiwane: false)");
  console.log("report:", piWithoutModel.report);
}



main();
