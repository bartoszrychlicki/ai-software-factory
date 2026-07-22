import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { notifyMacos, notifyTelegram } from "../pipeline/notify";

type CommandCall = { file: string; args: readonly string[] };
type Failure = (file: string, args: readonly string[]) => Error | undefined;

function commandRunner(calls: CommandCall[], failure?: Failure) {
  return async (file: string, args: readonly string[]): Promise<void> => {
    calls.push({ file, args: [...args] });
    const error = failure?.(file, args);
    if (error) throw error;
  };
}

test("macOS wybiera linear:// i dokładne argv terminal-notifier, gdy aplikacja Linear istnieje", async () => {
  const calls: CommandCall[] = [];

  await notifyMacos(
    "Tytuł",
    "Treść",
    "https://linear.app/acme/issue/BAR-164/test",
    commandRunner(calls),
  );

  assert.deepEqual(calls, [
    { file: "open", args: ["-Ra", "Linear"] },
    {
      file: "terminal-notifier",
      args: [
        "-title",
        "Tytuł",
        "-message",
        "Treść",
        "-open",
        "linear://linear.app/acme/issue/BAR-164/test",
      ],
    },
  ]);
});

test("macOS pozostawia HTTPS, gdy aplikacji Linear nie ma", async () => {
  const calls: CommandCall[] = [];

  await notifyMacos(
    "Tytuł",
    "Treść",
    "https://linear.app/acme/issue/BAR-164/test",
    commandRunner(calls, (file) => file === "open" ? new Error("Linear app not found") : undefined),
  );

  assert.deepEqual(calls.at(-1), {
    file: "terminal-notifier",
    args: [
      "-title",
      "Tytuł",
      "-message",
      "Treść",
      "-open",
      "https://linear.app/acme/issue/BAR-164/test",
    ],
  });
});

test("macOS używa osascript jako awaryjnego fallbacku po ENOENT terminal-notifier", async () => {
  const calls: CommandCall[] = [];
  const failure: Failure = (file) => {
    if (file !== "terminal-notifier") return undefined;
    return Object.assign(new Error("spawn terminal-notifier ENOENT"), { code: "ENOENT" });
  };

  await notifyMacos(
    "Tytuł",
    "Treść",
    "https://linear.app/acme/issue/BAR-164/test",
    commandRunner(calls, failure),
  );

  assert.deepEqual(calls.map((call) => call.file), ["open", "terminal-notifier", "osascript"]);
  assert.deepEqual(calls[2], {
    file: "osascript",
    args: ["-e", 'display notification "Treść" with title "Tytuł" sound name "Glass"'],
  });
});

test("Telegram dodaje inline button z kanonicznym URL-em WWW", async () => {
  const originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.TELEGRAM_CHAT_ID = "test-chat";
  let request: { input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] } | undefined;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      request = { input, init };
      return new Response("{}", { status: 200 });
    },
  );

  try {
    const canonicalUrl = "https://linear.app/acme/issue/BAR-164/test";
    await notifyTelegram("Tytuł", "Treść", canonicalUrl);

    assert.equal(String(request?.input), "https://api.telegram.org/bottest-token/sendMessage");
    const body = JSON.parse(String(request?.init?.body));
    assert.deepEqual(body.reply_markup, {
      inline_keyboard: [[{ text: "Otwórz w Linear", url: canonicalUrl }]],
    });
  } finally {
    fetchMock.mock.restore();
    if (originalBotToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
    if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = originalChatId;
  }
});
